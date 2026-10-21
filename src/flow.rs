//! One PISA payment, split into the steps a viewer should see.
//!
//! Bob's wallet opens a BIP 77 session and waits on the payjoin directory.
//! Alice's wallet pays the URI he shows. Both run as their own task and talk
//! only through the directory and the OHTTP relay, as two phones would; the
//! demo merely hosts both wallets in one process.
//!
//! The aggregation steps are pisa's: [`declare_fullagg`] on Alice's original
//! PSBT, [`input_pair`] for Bob's contribution, and Bitcoin Core's
//! `walletprocesspsbt` for the partial signatures and the aggregate.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use bitcoin::{Amount, FeeRate, OutPoint, Psbt, Script, Transaction, TxOut, Txid};
use payjoin::cisa;
use payjoin::persist::OptionalTransitionOutcome;
use payjoin::receive::v2::{Initialized, Receiver, ReceiverBuilder, SessionEvent};
use payjoin::receive::InputPair;
use payjoin::send::v2::SenderBuilder;
use payjoin::{ImplementationError, OhttpKeys, PjUri, Request, Uri};
use payjoin_test_utils::{InMemoryPersister, TestServices};
use pisa::receiver::{input_pair, Spend};
use pisa::sender::declare_fullagg;
use pisa::wallet::{AggregatingWallet, CoreWallet};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::chain::Wallets;
use crate::events::{Actor, Hub};

/// The fee rate Alice builds her fallback at, and the most Bob pays for what
/// he adds. Regtest has no fee market; this keeps the numbers small and real.
const FEE_RATE: FeeRate = FeeRate::from_sat_per_vb_u32(2);

/// How often a party asks the directory whether its counterparty answered.
const POLL_INTERVAL: Duration = Duration::from_millis(400);

/// The payjoin directory and OHTTP relay, in-process.
pub struct Services {
    inner: TestServices,
    agent: reqwest::Client,
    ohttp_keys: OhttpKeys,
}

impl Services {
    pub async fn start() -> Result<Self> {
        let inner = TestServices::initialize().await.map_err(|e| anyhow!(e))?;
        inner
            .wait_for_services_ready()
            .await
            .map_err(|e| anyhow!(e))?;
        let agent = reqwest::Client::builder()
            .no_proxy()
            .add_root_certificate(reqwest::Certificate::from_der(&inner.cert())?)
            .build()?;
        let ohttp_keys = inner.fetch_ohttp_keys().await?;
        Ok(Self {
            inner,
            agent,
            ohttp_keys,
        })
    }

    pub fn directory(&self) -> String {
        self.inner.directory_url()
    }

    pub fn relay(&self) -> String {
        self.inner.ohttp_relay_url()
    }

    async fn post(&self, request: Request) -> Result<Vec<u8>> {
        let response = self
            .agent
            .post(request.url)
            .header("Content-Type", request.content_type)
            .body(request.body)
            .send()
            .await?;
        if !response.status().is_success() {
            bail!("the directory returned {}", response.status());
        }
        Ok(response.bytes().await?.to_vec())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Invoice {
    pub uri: String,
    pub address: String,
    pub amount_sat: u64,
    pub qr_svg: String,
    /// waiting, negotiating, proposed, paid, failed
    pub status: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct Payment {
    pub uri: String,
    pub amount_sat: u64,
    /// sending, waiting, finalizing, broadcast, failed
    pub status: &'static str,
    pub txid: Option<String>,
    pub summary: Option<TxSummary>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Session {
    pub invoice: Option<Invoice>,
    pub payment: Option<Payment>,
    receiver_task: Option<JoinHandle<()>>,
    sender_task: Option<JoinHandle<()>>,
    /// Payjoins made in this run, so the wallets can label them.
    pub payjoins: BTreeSet<Txid>,
}

impl Session {
    pub fn remembering(payjoins: BTreeSet<Txid>) -> Self {
        Self {
            payjoins,
            ..Self::default()
        }
    }

    fn abort_tasks(&mut self) {
        for task in [self.receiver_task.take(), self.sender_task.take()]
            .into_iter()
            .flatten()
        {
            task.abort();
        }
    }
}

pub struct Demo {
    pub hub: Hub,
    pub wallets: Wallets,
    pub services: Services,
    /// The pause between the steps of a payment, so a viewer can follow.
    pub pace: Duration,
    pub explorer: String,
    pub session: Mutex<Session>,
    /// Where the payjoins of this chain are remembered across restarts, so
    /// the wallets keep labelling them. Lives in the node's datadir, so a
    /// fresh chain forgets them too.
    pub payjoin_log: std::path::PathBuf,
}

/// The payjoins recorded for this chain.
pub fn load_payjoins(path: &std::path::Path) -> BTreeSet<Txid> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

impl Demo {
    async fn pause(&self) {
        tokio::time::sleep(self.pace).await;
    }

    /// Cancel whatever is in flight and forget the narration. The chain and
    /// the wallets' coins stay as they are.
    pub async fn reset(&self) {
        let mut session = self.session.lock().await;
        session.abort_tasks();
        session.invoice = None;
        session.payment = None;
        self.hub.clear();
        self.hub
            .emit(Actor::System, "system.reset", "Ready", None, json!({}));
    }
}

// ---------------------------------------------------------------------------
// Bob: the receiver

pub async fn create_invoice(demo: &Arc<Demo>, amount: Amount) -> Result<Invoice> {
    let mut session = demo.session.lock().await;
    if let Some(task) = session.receiver_task.take() {
        task.abort();
    }

    let bob = &demo.wallets.bob;
    let address = bob.get_new_address()?;
    let persister = InMemoryPersister::<SessionEvent>::default();
    let receiver = ReceiverBuilder::new(
        address.clone(),
        demo.services.directory().as_str(),
        demo.services.ohttp_keys.clone(),
    )?
    .with_amount(amount)
    .build()
    .save(&persister)?;
    let uri = receiver.pj_uri().to_string();

    let invoice = Invoice {
        qr_svg: qr_svg(&uri)?,
        uri: uri.clone(),
        address: address.to_string(),
        amount_sat: amount.to_sat(),
        status: "waiting",
    };
    session.invoice = Some(invoice.clone());
    demo.hub.emit(
        Actor::Bob,
        "bob.invoice",
        "Payment request created",
        Some(format!(
            "{} to a witness v2 address, with a mailbox on the payjoin directory",
            btc(amount)
        )),
        json!({ "uri": uri, "address": address.to_string(), "amount_sat": amount.to_sat() }),
    );
    demo.hub.emit(
        Actor::Bob,
        "bob.listening",
        "Waiting for the sender",
        Some("Polling the directory through the OHTTP relay".into()),
        json!({}),
    );

    let task_demo = demo.clone();
    session.receiver_task = Some(tokio::spawn(async move {
        if let Err(e) = receive(&task_demo, receiver, persister).await {
            task_demo.hub.emit(
                Actor::Bob,
                "bob.error",
                "Payjoin failed",
                Some(format!("{e:#}")),
                json!({}),
            );
            set_invoice_status(&task_demo, "failed").await;
        }
    }));
    Ok(invoice)
}

async fn set_invoice_status(demo: &Demo, status: &'static str) {
    if let Some(invoice) = demo.session.lock().await.invoice.as_mut() {
        invoice.status = status;
    }
}

async fn receive(
    demo: &Arc<Demo>,
    mut session: Receiver<Initialized>,
    persister: InMemoryPersister<SessionEvent>,
) -> Result<()> {
    let relay = demo.services.relay();
    let bob = &demo.wallets.bob;

    let original = loop {
        let (request, ctx) = session.create_poll_request(relay.as_str())?;
        let response = demo.services.post(request).await?;
        match session.process_response(&response, ctx).save(&persister)? {
            OptionalTransitionOutcome::Progress(original) => break original,
            OptionalTransitionOutcome::Stasis(current) => {
                session = current;
                tokio::time::sleep(POLL_INTERVAL).await;
            }
        }
    };
    // The directory hands the PSBT over the moment it arrives, before Alice
    // has heard back from her own post. Let her side of the story go first.
    demo.pause().await;
    set_invoice_status(demo, "negotiating").await;
    demo.hub.emit(
        Actor::Directory,
        "directory.to_bob",
        "Original PSBT delivered to Bob",
        None,
        json!({}),
    );
    demo.hub.emit(
        Actor::Bob,
        "bob.original_received",
        "Alice's PSBT arrived",
        Some("Her payment, signed as a fallback, carrying her aggregation nonce".into()),
        json!({}),
    );
    demo.pause().await;

    let proposal = original
        .check_broadcast_suitability(None, |tx| {
            bob.can_broadcast(tx).map_err(implementation_error)
        })
        .save(&persister)?
        .check_inputs_not_owned(&mut |outpoint| {
            let txout = bob.get_txout(*outpoint).map_err(implementation_error)?;
            bob.is_mine(&txout.script_pubkey)
                .map_err(implementation_error)
        })
        .save(&persister)?
        .check_no_inputs_seen_before(&mut |_| Ok(false))
        .save(&persister)?
        .identify_receiver_outputs(&mut |script| bob.is_mine(script).map_err(implementation_error))
        .save(&persister)?
        .commit_outputs()
        .save(&persister)?;
    demo.hub.emit(
        Actor::Bob,
        "bob.checks",
        "Checks passed",
        Some("The fallback is broadcastable, none of its inputs are mine, and it pays me".into()),
        json!({}),
    );
    demo.pause().await;

    let (coin, txout) = choose_coin(bob, &proposal)?;
    let contribution = input_pair(bob, coin, txout.clone(), Spend::Aggregated)?;
    let proposal = proposal
        .contribute_inputs(vec![contribution])
        .map_err(|e| anyhow!("contributing inputs failed: {e:?}"))?
        .commit_inputs()
        .save(&persister)?
        .apply_fee_range(Some(FeeRate::BROADCAST_MIN), Some(FEE_RATE))
        .save(&persister)?;
    demo.hub.emit(
        Actor::Bob,
        "bob.contributed",
        "Added one of my coins",
        Some(format!(
            "{} joins Alice's input in one aggregation group; nonce reserved",
            btc(txout.value)
        )),
        psbt_view(demo, &proposal.psbt_to_sign()),
    );
    demo.pause().await;

    let proposal = proposal
        .finalize_proposal(|psbt: &Psbt| bob.process_psbt(psbt).map_err(implementation_error))
        .save(&persister)?;
    let proposal_psbt = proposal.psbt().clone();
    demo.hub.emit(
        Actor::Bob,
        "bob.partial_signed",
        "Partial signature created",
        Some("32 bytes over the whole transaction. Only Alice can complete the signature".into()),
        psbt_view(demo, &proposal_psbt),
    );
    demo.pause().await;

    let (request, ctx) = proposal.create_post_request(relay.as_str())?;
    let response = demo.services.post(request).await?;
    proposal.process_response(&response, ctx).save(&persister)?;
    set_invoice_status(demo, "proposed").await;
    demo.hub.emit(
        Actor::Bob,
        "bob.proposal_sent",
        "Proposal sent back",
        Some("Through the relay to the directory. No nonce state kept".into()),
        psbt_view(demo, &proposal_psbt),
    );

    // The txid does not commit to witnesses, so the proposal's txid is the
    // txid of the transaction Alice will broadcast.
    let txid = proposal_psbt.unsigned_tx.compute_txid();
    watch_for_payment(demo, txid).await
}

/// Pick the coin to contribute without reserving a nonce for every coin in
/// the wallet: choose among plain candidates, then reserve for the one picked.
fn choose_coin(
    bob: &CoreWallet,
    proposal: &Receiver<payjoin::receive::v2::WantsInputs>,
) -> Result<(OutPoint, TxOut)> {
    // Unconfirmed coins too: the coin Bob got back from the last payjoin is
    // as good as any, and takes back to back need not wait for a block.
    let unspent: Value = bob.rpc().call("listunspent", &[json!(0)])?;
    let mut coins = BTreeMap::new();
    for utxo in unspent.as_array().into_iter().flatten() {
        let outpoint = OutPoint {
            txid: utxo["txid"].as_str().unwrap_or_default().parse()?,
            vout: utxo["vout"].as_u64().unwrap_or_default() as u32,
        };
        let txout = TxOut {
            value: Amount::from_btc(utxo["amount"].as_f64().unwrap_or_default())?,
            script_pubkey: bitcoin::ScriptBuf::from_hex(
                utxo["scriptPubKey"].as_str().unwrap_or_default(),
            )?,
        };
        coins.insert(outpoint, txout);
    }
    if coins.is_empty() {
        bail!("Bob has no coins to contribute");
    }
    let candidates: Vec<InputPair> = coins
        .iter()
        .map(|(outpoint, txout)| input_pair(bob, *outpoint, txout.clone(), Spend::Separate))
        .collect::<Result<_>>()?;
    let chosen = proposal
        .try_preserving_privacy(candidates.clone())
        .map(|pair| pair.outpoint())
        .unwrap_or_else(|_| candidates[0].outpoint());
    let txout = coins[&chosen].clone();
    Ok((chosen, txout))
}

async fn watch_for_payment(demo: &Arc<Demo>, txid: Txid) -> Result<()> {
    let bob = demo.wallets.bob.rpc();
    for _ in 0..(30 * 60 * 1000 / POLL_INTERVAL.as_millis() as u64) {
        if bob
            .call::<Value>("gettransaction", &[json!(txid.to_string())])
            .is_ok()
        {
            set_invoice_status(demo, "paid").await;
            demo.hub.emit(
                Actor::Bob,
                "bob.paid",
                "Payment received",
                Some("Seen in the mempool, waiting for a block".into()),
                json!({ "txid": txid.to_string() }),
            );
            return Ok(());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Alice: the sender

pub async fn pay(demo: &Arc<Demo>, uri: &str) -> Result<Payment> {
    let pj_uri = parse_uri(uri)?;
    let amount = pj_uri
        .amount()
        .context("the payment request has no amount")?;
    let payment = Payment {
        uri: uri.to_string(),
        amount_sat: amount.to_sat(),
        status: "sending",
        txid: None,
        summary: None,
        error: None,
    };
    let mut session = demo.session.lock().await;
    if let Some(task) = session.sender_task.take() {
        task.abort();
    }
    session.payment = Some(payment.clone());
    let task_demo = demo.clone();
    session.sender_task = Some(tokio::spawn(async move {
        if let Err(e) = send(&task_demo, pj_uri, amount).await {
            task_demo.hub.emit(
                Actor::Alice,
                "alice.error",
                "Payment failed",
                Some(format!("{e:#}")),
                json!({}),
            );
            if let Some(payment) = task_demo.session.lock().await.payment.as_mut() {
                payment.status = "failed";
                payment.error = Some(format!("{e:#}"));
            }
        }
    }));
    Ok(payment)
}

pub fn parse_uri(uri: &str) -> Result<PjUri> {
    Uri::from_str(uri.trim())
        .map_err(|e| anyhow!("not a bitcoin URI: {e}"))?
        .assume_checked()
        .check_pj_supported()
        .map_err(|_| anyhow!("this payment request does not support payjoin"))
}

async fn set_payment_status(demo: &Demo, status: &'static str) {
    if let Some(payment) = demo.session.lock().await.payment.as_mut() {
        payment.status = status;
    }
}

async fn send(demo: &Arc<Demo>, pj_uri: PjUri, amount: Amount) -> Result<()> {
    let alice = &demo.wallets.alice;
    let relay = demo.services.relay();
    demo.hub.emit(
        Actor::Alice,
        "alice.start",
        format!("Paying {}", btc(amount)),
        Some("Bob's request supports payjoin, and his address is witness v2".into()),
        json!({ "amount_sat": amount.to_sat() }),
    );

    let mut original = alice.create_psbt(&[(pj_uri.address().clone(), amount)], FEE_RATE)?;
    demo.hub.emit(
        Actor::Alice,
        "alice.fallback",
        "Fallback transaction signed",
        Some("An ordinary payment Bob may broadcast if the payjoin goes wrong".into()),
        psbt_view(demo, &original),
    );
    demo.pause().await;

    let declared = declare_fullagg(&mut original, alice)?;
    if declared == 0 {
        bail!("none of the inputs Alice spends is witness v2, nothing to aggregate");
    }
    demo.hub.emit(
        Actor::Alice,
        "alice.nonce",
        "Joined an aggregation group",
        Some(format!(
            "Reserved a signing nonce for {}; the PSBT carries its public half",
            plural(declared, "my input", "each of my inputs")
        )),
        psbt_view(demo, &original),
    );
    demo.pause().await;

    let persister = InMemoryPersister::default();
    let sender = SenderBuilder::new(original.clone(), pj_uri)
        .build_recommended(FeeRate::BROADCAST_MIN)?
        .save(&persister)?;
    let (request, ctx) = sender.create_v2_post_request(relay.as_str())?;
    let response = demo.services.post(request).await?;
    let mut polling = sender.process_response(&response, ctx).save(&persister)?;
    set_payment_status(demo, "waiting").await;
    demo.hub.emit(
        Actor::Alice,
        "alice.original_sent",
        "Original PSBT sent",
        Some("Encrypted for Bob, through the OHTTP relay to the directory".into()),
        psbt_view(demo, &original),
    );

    let proposal = loop {
        let (request, ctx) = polling.create_poll_request(relay.as_str())?;
        let response = demo.services.post(request).await?;
        match polling.process_response(&response, ctx).save(&persister)? {
            OptionalTransitionOutcome::Progress(psbt) => break psbt,
            OptionalTransitionOutcome::Stasis(current) => {
                polling = current;
                tokio::time::sleep(POLL_INTERVAL).await;
            }
        }
    };
    demo.pause().await;
    set_payment_status(demo, "finalizing").await;
    demo.hub.emit(
        Actor::Directory,
        "directory.to_alice",
        "Proposal delivered to Alice",
        None,
        json!({}),
    );
    let added = proposal.inputs.len().saturating_sub(original.inputs.len());
    demo.hub.emit(
        Actor::Alice,
        "alice.proposal",
        "Bob's proposal arrived",
        Some(format!(
            "Bob added {}, with his nonce and partial signature; my fields intact",
            plural(added, "one input", &format!("{added} inputs"))
        )),
        psbt_view(demo, &proposal),
    );
    demo.pause().await;

    let transaction = finalize(alice, &proposal)?;
    let summary = summarize(demo, &transaction, &proposal);
    demo.hub.emit(
        Actor::Alice,
        "alice.aggregated",
        "One signature for the whole transaction",
        Some(format!(
            "Checked Bob's partial signature, signed my input, and combined them: {} inputs, {} signature",
            summary.inputs.len(),
            summary.signatures
        )),
        serde_json::to_value(&summary)?,
    );
    demo.pause().await;

    let txid = alice.broadcast_tx(&transaction)?;
    {
        let mut session = demo.session.lock().await;
        session.payjoins.insert(txid);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&demo.payjoin_log)
            .and_then(|mut f| std::io::Write::write_all(&mut f, format!("{txid}\n").as_bytes()));
        if let Some(payment) = session.payment.as_mut() {
            payment.status = "broadcast";
            payment.txid = Some(txid.to_string());
            payment.summary = Some(summary.clone());
        }
    }
    demo.hub.emit(
        Actor::Alice,
        "alice.broadcast",
        "Payment sent",
        Some(format!("Broadcast {}", short_txid(&txid))),
        json!({ "txid": txid.to_string(), "summary": summary }),
    );
    Ok(())
}

/// Sign Alice's input and aggregate the group, then pull out the
/// transaction. Bitcoin Core does both in one `walletprocesspsbt` once
/// every partial signature but its own is present.
fn finalize(alice: &CoreWallet, proposal: &Psbt) -> Result<Transaction> {
    let signed = alice.process_psbt(proposal)?;
    let finalized = alice.rpc().finalize_psbt(&signed)?;
    let Some(finalized) = finalized.psbt else {
        bail!("the proposal did not finalize")
    };
    Ok(Psbt::from_str(&finalized)?.extract_tx()?)
}

// ---------------------------------------------------------------------------
// What the UI shows of PSBTs and transactions

fn owner(demo: &Demo, script: &Script) -> &'static str {
    if demo.wallets.alice.is_mine(script).unwrap_or(false) {
        "alice"
    } else if demo.wallets.bob.is_mine(script).unwrap_or(false) {
        "bob"
    } else {
        "other"
    }
}

/// Which CISA fields each input carries, and who owns what.
fn psbt_view(demo: &Demo, psbt: &Psbt) -> Value {
    let inputs: Vec<Value> = psbt
        .inputs
        .iter()
        .map(|input| {
            let utxo = input.witness_utxo.as_ref();
            json!({
                "owner": utxo.map(|u| owner(demo, &u.script_pubkey)).unwrap_or("other"),
                "value_sat": utxo.map(|u| u.value.to_sat()),
                "mode": cisa::mode(input).map(|m| format!("0x{m:02x}")),
                "pubnonce": cisa::fullagg_pub_nonce(input).is_some(),
                "partial_sig": cisa::fullagg_partial_sig(input).is_some(),
                "fallback_sig": input.final_script_witness.is_some(),
            })
        })
        .collect();
    let outputs: Vec<Value> = psbt
        .unsigned_tx
        .output
        .iter()
        .map(|txout| {
            json!({
                "owner": owner(demo, &txout.script_pubkey),
                "value_sat": txout.value.to_sat(),
            })
        })
        .collect();
    json!({ "psbt": { "inputs": inputs, "outputs": outputs } })
}

#[derive(Clone, Debug, Serialize)]
pub struct TxSummary {
    pub txid: String,
    pub weight: u64,
    pub vsize: u64,
    /// What the same transaction would weigh with every input signed on its
    /// own, which is what it costs today.
    pub vsize_without_cisa: u64,
    pub weight_without_cisa: u64,
    pub fee_sat: Option<u64>,
    pub signatures: usize,
    pub inputs: Vec<InputSummary>,
    pub outputs: Vec<OutputSummary>,
    /// The explorer's payjoin ownership fragment: who owns which input and
    /// output, with names, so the explorer can label Alice and Bob.
    pub pj_fragment: Option<String>,
}

/// `pj=1:<inputs>:<outputs>:Alice:Bob`, one code per input and output: `s`
/// for the sender, `r` for the recipient. None if anything belongs to
/// neither, which a payjoin between the two never does.
fn pj_fragment(inputs: &[InputSummary], outputs: &[OutputSummary]) -> Option<String> {
    let code = |owner: &str| match owner {
        "alice" => Some('s'),
        "bob" => Some('r'),
        _ => None,
    };
    let ins: Option<String> = inputs.iter().map(|i| code(i.owner)).collect();
    let outs: Option<String> = outputs.iter().map(|o| code(o.owner)).collect();
    Some(format!("pj=1:{}:{}:Alice:Bob", ins?, outs?))
}

#[derive(Clone, Debug, Serialize)]
pub struct InputSummary {
    pub owner: &'static str,
    pub value_sat: Option<u64>,
    /// Lengths of the witness elements.
    pub witness: Vec<usize>,
    /// aggregated (empty witness), aggregate (carries the signature for the
    /// group), or single (an ordinary signature)
    pub role: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct OutputSummary {
    pub owner: &'static str,
    pub value_sat: u64,
}

fn summarize(demo: &Demo, tx: &Transaction, psbt: &Psbt) -> TxSummary {
    let inputs: Vec<InputSummary> = tx
        .input
        .iter()
        .zip(&psbt.inputs)
        .map(|(txin, input)| {
            let witness: Vec<usize> = txin.witness.iter().map(<[u8]>::len).collect();
            let role = match witness.as_slice() {
                [0] => "aggregated",
                [cisa::FULLAGG_FINAL_WITNESS_LEN] if cisa::is_fullagg(input) => "aggregate",
                _ => "single",
            };
            let utxo = input.witness_utxo.as_ref();
            InputSummary {
                owner: utxo
                    .map(|u| owner(demo, &u.script_pubkey))
                    .unwrap_or("other"),
                value_sat: utxo.map(|u| u.value.to_sat()),
                witness,
                role,
            }
        })
        .collect();
    let outputs: Vec<OutputSummary> = tx
        .output
        .iter()
        .map(|txout| OutputSummary {
            owner: owner(demo, &txout.script_pubkey),
            value_sat: txout.value.to_sat(),
        })
        .collect();
    let pj_fragment = pj_fragment(&inputs, &outputs);
    let signatures = inputs.iter().filter(|i| i.role != "aggregated").count();
    // A group of n inputs saves the 64-byte signature on every input but its
    // last, and its last pays one marker byte.
    let aggregated = inputs.iter().filter(|i| i.role == "aggregated").count() as u64;
    let has_group = inputs.iter().any(|i| i.role == "aggregate");
    let extra = if has_group { aggregated * 64 - 1 } else { 0 };
    let weight = tx.weight().to_wu();
    let input_total: Option<u64> = inputs.iter().map(|i| i.value_sat).sum();
    let output_total: u64 = tx.output.iter().map(|o| o.value.to_sat()).sum();
    TxSummary {
        txid: tx.compute_txid().to_string(),
        weight,
        vsize: weight.div_ceil(4),
        vsize_without_cisa: (weight + extra).div_ceil(4),
        weight_without_cisa: weight + extra,
        fee_sat: input_total.map(|total| total.saturating_sub(output_total)),
        signatures,
        inputs,
        outputs,
        pj_fragment,
    }
}

fn qr_svg(data: &str) -> Result<String> {
    use qrcode::render::svg;
    // BIP 21 allows an uppercase URI, which fits a smaller QR code, but the
    // pj parameter is case sensitive in parts; encode it as it is.
    let code = qrcode::QrCode::with_error_correction_level(data.as_bytes(), qrcode::EcLevel::L)?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(260, 260)
        .quiet_zone(false)
        .dark_color(svg::Color("#0b0d12"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        one.to_string()
    } else {
        many.to_string()
    }
}

pub fn btc(amount: Amount) -> String {
    format!("{:.8} BTC", amount.to_btc())
}

fn short_txid(txid: &Txid) -> String {
    let s = txid.to_string();
    format!("{}…{}", &s[..8], &s[s.len() - 8..])
}

/// The typestate callbacks take a boxed error, not an `anyhow` one.
fn implementation_error(e: anyhow::Error) -> ImplementationError {
    ImplementationError::from(e.to_string().as_str())
}

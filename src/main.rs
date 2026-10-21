//! A web UI for a PISA payment: two wallets, Alice and Bob, making an async
//! payjoin whose inputs share one BIP 460 signature, on a regtest node that
//! the mempool explorer watches.

mod chain;
mod events;
mod flow;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::{header, HeaderValue};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bitcoin::Amount;
use futures::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing_subscriber::EnvFilter;

use crate::chain::{Bitcoind, Funding, NodeConfig};
use crate::events::{Actor, Hub};
use crate::flow::{Demo, Services, Session};

const USAGE: &str = "\
Usage: pisa-demo [options]

  --bitcoind <path>     a bitcoind built from the bip460 branch
                        (default: $BITCOIND_EXE)
  --datadir <path>      the regtest node's datadir (default: .data/bitcoin)
  --fresh               wipe the datadir and start a new chain
  --port <n>            the web UI's port (default 3000)
  --rpc-port <n>        the node's RPC port, for the explorer (default 18443)
  --explorer <url>      the mempool explorer (default http://localhost:4200)
  --pace-ms <n>         pause between the steps of a payment (default 1100)
  -h, --help            print this";

struct Options {
    bitcoind: PathBuf,
    datadir: PathBuf,
    fresh: bool,
    port: u16,
    rpc_port: u16,
    explorer: String,
    pace: Duration,
}

fn parse() -> Result<Option<Options>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut options = Options {
        bitcoind: std::env::var_os("BITCOIND_EXE")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("../src/bitcoin/build/bin/bitcoind")),
        datadir: chain::datadir_default(&root),
        fresh: false,
        port: 3000,
        rpc_port: 18443,
        explorer: "http://localhost:4200".into(),
        pace: Duration::from_millis(1100),
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().with_context(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--bitcoind" => options.bitcoind = value()?.into(),
            "--datadir" => options.datadir = value()?.into(),
            "--fresh" => options.fresh = true,
            "--port" => options.port = value()?.parse()?,
            "--rpc-port" => options.rpc_port = value()?.parse()?,
            "--explorer" => options.explorer = value()?.trim_end_matches('/').to_string(),
            "--pace-ms" => options.pace = Duration::from_millis(value()?.parse()?),
            other => bail!("unknown argument {other}\n\n{USAGE}"),
        }
    }
    Ok(Some(options))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "pisa_demo=info,pisa=info".into()),
        )
        .with_target(false)
        .init();
    let Some(options) = parse()? else {
        println!("{USAGE}");
        return Ok(());
    };

    let config = NodeConfig {
        exe: options.bitcoind.clone(),
        datadir: options.datadir.clone(),
        rpc_port: options.rpc_port,
        p2p_port: options.rpc_port + 1,
        fresh: options.fresh,
    };
    let node = tokio::task::spawn_blocking(move || Bitcoind::start(&config)).await??;
    tracing::info!("bitcoind up, RPC {}", node.rpc_url(None));
    let wallets = {
        let node = &node;
        tokio::task::block_in_place(|| chain::setup(node, &Funding::default()))?
    };
    let services = Services::start().await?;
    tracing::info!(
        "payjoin directory {} and OHTTP relay {} running in-process",
        services.directory(),
        services.relay()
    );

    let payjoin_log = options.datadir.join("payjoins.txt");
    let demo = Arc::new(Demo {
        hub: Hub::new(),
        wallets,
        services,
        pace: options.pace,
        explorer: options.explorer.clone(),
        session: Mutex::new(Session::remembering(flow::load_payjoins(&payjoin_log))),
        payjoin_log,
    });
    demo.hub
        .emit(Actor::System, "system.ready", "Ready", None, json!({}));

    let static_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("static");
    let app = Router::new()
        .route("/api/state", get(state))
        .route("/api/events", get(events))
        .route("/api/invoice", get(current_invoice))
        .route("/api/bob/invoice", post(create_invoice))
        .route("/api/alice/pay", post(pay))
        .route("/api/mine", post(mine))
        .route("/api/reset", post(reset))
        .fallback_service(ServeDir::new(static_dir))
        .with_state(demo.clone())
        // A take is recorded right after an edit more often than not; never
        // let the browser show yesterday's stylesheet.
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ));

    let addr = SocketAddr::from(([127, 0, 0, 1], options.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!();
    println!("  wallets   http://localhost:{}", options.port);
    println!("  explorer  {}", options.explorer);
    println!(
        "  node rpc  {} user {} password {}",
        node.rpc_url(None),
        chain::RPC_USER,
        chain::RPC_PASSWORD
    );
    println!();
    // Not a graceful shutdown: every open page holds an event stream that
    // never ends on its own, and waiting for those would leave the node
    // running when whoever stops the demo runs out of patience.
    tokio::select! {
        served = axum::serve(listener, app) => served?,
        _ = shutdown_signal() => tracing::info!("stopping"),
    }
    drop(demo);
    tokio::task::spawn_blocking(move || drop(node)).await?;
    Ok(())
}

/// Ctrl-C or a plain kill both stop the node on the way out, so that no
/// bitcoind is left holding the demo's ports and datadir.
async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("installing the SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}

struct ApiError(anyhow::Error);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("{:#}", self.0) })),
        )
            .into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}

type ApiResult = Result<Json<Value>, ApiError>;

async fn state(State(demo): State<Arc<Demo>>) -> ApiResult {
    let (invoice, payment, payjoins) = {
        let session = demo.session.lock().await;
        (
            session.invoice.clone(),
            session.payment.clone(),
            session.payjoins.clone(),
        )
    };
    let wallets = tokio::task::block_in_place(|| -> Result<Value> {
        Ok(json!({
            "alice": wallet_view(demo.wallets.alice.rpc(), &payjoins)?,
            "bob": wallet_view(demo.wallets.bob.rpc(), &payjoins)?,
        }))
    })?;
    let height = tokio::task::block_in_place(|| chain::block_count(&demo.wallets.node))?;
    Ok(Json(json!({
        "height": height,
        "explorer": demo.explorer,
        "pace_ms": demo.pace.as_millis() as u64,
        "wallets": wallets,
        "invoice": invoice,
        "payment": payment,
    })))
}

/// A wallet's balance and recent transactions, each with its net effect on
/// the wallet.
fn wallet_view(
    rpc: &payjoin_test_utils::corepc_node::Client,
    payjoins: &std::collections::BTreeSet<bitcoin::Txid>,
) -> Result<Value> {
    let balances: Value = rpc.call("getbalances", &[])?;
    let confirmed = sat(&balances["mine"]["trusted"]);
    let pending = sat(&balances["mine"]["untrusted_pending"]);
    let listed: Value = rpc.call("listtransactions", &[json!("*"), json!(50)])?;
    let mut seen = std::collections::BTreeSet::new();
    let mut txs = Vec::new();
    for entry in listed.as_array().into_iter().flatten().rev() {
        let Some(txid) = entry["txid"].as_str() else {
            continue;
        };
        if !seen.insert(txid.to_string()) {
            continue;
        }
        let tx: Value = rpc.call("gettransaction", &[json!(txid)])?;
        // Core reports a "fee" for any transaction that spends one of the
        // wallet's coins, computed as if every input were the wallet's. For
        // a payjoin that is wrong; the net change in the wallet is right.
        let net = sat(&tx["amount"]) + sat(&tx["fee"]);
        let payjoin = txid
            .parse::<bitcoin::Txid>()
            .map(|t| payjoins.contains(&t))
            .unwrap_or(false);
        txs.push(json!({
            "txid": txid,
            "net_sat": net,
            "confirmations": tx["confirmations"].as_i64().unwrap_or(0),
            "time": tx["time"].as_u64().unwrap_or(0),
            "payjoin": payjoin,
        }));
        if txs.len() == 8 {
            break;
        }
    }
    Ok(json!({
        "confirmed_sat": confirmed,
        "pending_sat": pending,
        "txs": txs,
    }))
}

fn sat(value: &Value) -> i64 {
    value
        .as_f64()
        .map(|btc| (btc * 100_000_000.0).round() as i64)
        .unwrap_or(0)
}

async fn events(
    State(demo): State<Arc<Demo>>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let (history, rx) = demo.hub.subscribe();
    let past = stream::iter(history);
    let live = BroadcastStream::new(rx).filter_map(|e| async move { e.ok() });
    let stream = past.chain(live).map(|event| {
        Ok(SseEvent::default()
            .json_data(&event)
            .unwrap_or_else(|_| SseEvent::default().data("{}")))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn current_invoice(State(demo): State<Arc<Demo>>) -> ApiResult {
    let invoice = demo.session.lock().await.invoice.clone();
    Ok(Json(json!({ "invoice": invoice })))
}

#[derive(Deserialize)]
struct InvoiceRequest {
    amount_sat: u64,
}

async fn create_invoice(
    State(demo): State<Arc<Demo>>,
    Json(request): Json<InvoiceRequest>,
) -> ApiResult {
    if request.amount_sat < 1_000 {
        return Err(anyhow::anyhow!("ask for at least 1000 sat").into());
    }
    let invoice = flow::create_invoice(&demo, Amount::from_sat(request.amount_sat)).await?;
    Ok(Json(json!({ "invoice": invoice })))
}

#[derive(Deserialize)]
struct PayRequest {
    uri: String,
}

async fn pay(State(demo): State<Arc<Demo>>, Json(request): Json<PayRequest>) -> ApiResult {
    let payment = flow::pay(&demo, &request.uri).await?;
    Ok(Json(json!({ "payment": payment })))
}

#[derive(Deserialize, Default)]
struct MineRequest {
    blocks: Option<u64>,
}

async fn mine(State(demo): State<Arc<Demo>>, body: Option<Json<MineRequest>>) -> ApiResult {
    let blocks = body.and_then(|b| b.blocks).unwrap_or(1).clamp(1, 10);
    let (hashes, height, txids) = tokio::task::block_in_place(|| -> Result<_> {
        let node = &demo.wallets.node;
        let hashes = chain::generate(node, blocks, &demo.wallets.mine_to)?;
        let mut txids = Vec::new();
        for hash in &hashes {
            txids.extend(chain::block_txids(node, hash)?);
        }
        Ok((hashes, chain::block_count(node)?, txids))
    })?;
    let payjoins = demo.session.lock().await.payjoins.clone();
    let confirmed: Vec<String> = txids
        .iter()
        .filter(|t| payjoins.contains(*t))
        .map(ToString::to_string)
        .collect();
    demo.hub.emit(
        Actor::Chain,
        "chain.block",
        format!("Block {height} mined"),
        Some(format!(
            "{} transaction(s){}",
            txids.len(),
            if confirmed.is_empty() {
                ""
            } else {
                ", including the payjoin"
            }
        )),
        json!({
            "height": height,
            "hashes": hashes,
            "txids": txids.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "confirmed_payjoins": confirmed,
        }),
    );
    Ok(Json(json!({ "height": height })))
}

async fn reset(State(demo): State<Arc<Demo>>) -> ApiResult {
    demo.reset().await;
    Ok(Json(json!({ "ok": true })))
}

//! The regtest node and the wallets on it.
//!
//! Unlike pisa's own runs, which start a throwaway node in a temporary
//! directory, the demo keeps one node on fixed ports with a fixed datadir and
//! password, so that the mempool explorer can be pointed at it and stays
//! pointed at it between takes.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use bitcoin::bip32::Xpriv;
use bitcoin::{Address, Amount, Network, Txid};
use corepc_client::client_sync::Auth;
use payjoin_test_utils::corepc_node::Client;
use pisa::wallet::CoreWallet;
use serde_json::{json, Value};

pub const RPC_USER: &str = "pisa";
pub const RPC_PASSWORD: &str = "pisa";

pub struct NodeConfig {
    pub exe: PathBuf,
    pub datadir: PathBuf,
    pub rpc_port: u16,
    pub p2p_port: u16,
    pub fresh: bool,
}

/// A bitcoind child process. It is stopped when this is dropped.
pub struct Bitcoind {
    child: Option<Child>,
    rpc_port: u16,
}

impl Bitcoind {
    pub fn start(config: &NodeConfig) -> Result<Self> {
        if config.fresh && config.datadir.exists() {
            std::fs::remove_dir_all(&config.datadir)
                .with_context(|| format!("wiping {}", config.datadir.display()))?;
        }
        std::fs::create_dir_all(&config.datadir)?;
        let log = std::fs::File::create(config.datadir.join("bitcoind.out"))?;
        let child = Command::new(&config.exe)
            .arg("-regtest")
            .arg(format!("-datadir={}", config.datadir.display()))
            .arg("-server=1")
            .arg("-txindex=1")
            .arg("-listen=1")
            .arg("-bind=127.0.0.1")
            .arg(format!("-port={}", config.p2p_port))
            .arg("-rpcbind=127.0.0.1")
            .arg("-rpcallowip=127.0.0.1")
            .arg(format!("-rpcport={}", config.rpc_port))
            .arg(format!("-rpcuser={RPC_USER}"))
            .arg(format!("-rpcpassword={RPC_PASSWORD}"))
            .arg("-rpcworkqueue=64")
            .arg("-fallbackfee=0.00001")
            .arg("-printtoconsole=0")
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .spawn()
            .with_context(|| format!("starting {}", config.exe.display()))?;
        let node = Self {
            child: Some(child),
            rpc_port: config.rpc_port,
        };
        node.wait_ready()?;
        Ok(node)
    }

    pub fn rpc_url(&self, wallet: Option<&str>) -> String {
        match wallet {
            Some(name) => format!("http://127.0.0.1:{}/wallet/{name}", self.rpc_port),
            None => format!("http://127.0.0.1:{}", self.rpc_port),
        }
    }

    pub fn client(&self, wallet: Option<&str>) -> Result<Client> {
        Ok(Client::new_with_auth(
            &self.rpc_url(wallet),
            Auth::UserPass(RPC_USER.into(), RPC_PASSWORD.into()),
        )?)
    }

    fn wait_ready(&self) -> Result<()> {
        let client = self.client(None)?;
        for _ in 0..150 {
            if client
                .call::<Value>("getblockchaininfo", &[])
                .map(|info| info["chain"] == "regtest")
                .unwrap_or(false)
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        bail!("bitcoind did not answer RPC within 30 s; see bitcoind.out in its datadir")
    }
}

impl Drop for Bitcoind {
    fn drop(&mut self) {
        if let Ok(client) = self.client(None) {
            let _ = client.call::<Value>("stop", &[]);
        }
        if let Some(mut child) = self.child.take() {
            for _ in 0..50 {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
        }
    }
}

/// Everything on the node the demo uses: the two parties, and where the
/// miner's blocks pay to.
pub struct Wallets {
    pub alice: CoreWallet,
    pub bob: CoreWallet,
    pub mine_to: Address,
    /// The node itself, for chain queries.
    pub node: Client,
}

pub struct Funding {
    pub alice: Vec<Amount>,
    pub bob: Vec<Amount>,
}

impl Default for Funding {
    fn default() -> Self {
        Self {
            alice: vec![Amount::from_sat(2_500_000), Amount::from_sat(1_000_000)],
            bob: vec![Amount::from_sat(1_200_000), Amount::from_sat(650_000)],
        }
    }
}

/// Open the demo's wallets, creating and funding them on a fresh chain.
pub fn setup(node: &Bitcoind, funding: &Funding) -> Result<Wallets> {
    let root = node.client(None)?;
    let height = block_count(&root)?;
    let fresh = height == 0;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    if fresh {
        // A wallet ignores blocks from before its birth, and the history
        // below is backdated, so the wallets are born at its start.
        root.call::<Value>("setmocktime", &[json!(history_start(now))])?;
    }

    for name in ["miner", "alice", "bob"] {
        open_wallet(&root, name, fresh)?;
    }
    let miner = node.client(Some("miner"))?;
    let alice = node.client(Some("alice"))?;
    let bob = node.client(Some("bob"))?;
    if fresh {
        import_cisa_descriptor(&alice)?;
        import_cisa_descriptor(&bob)?;
    }

    let alice = CoreWallet::new(alice, Network::Regtest);
    let bob = CoreWallet::new(bob, Network::Regtest);
    let mine_to = new_address(&miner, "bech32m")?;

    if fresh {
        mine_history(&root, &mine_to, now)?;
        for (wallet, amounts) in [(&alice, &funding.alice), (&bob, &funding.bob)] {
            for amount in amounts {
                let address = wallet.get_new_address()?;
                miner.call::<Value>(
                    "sendtoaddress",
                    &[json!(address.to_string()), json!(amount.to_btc())],
                )?;
            }
        }
        generate(&root, 1, &mine_to)?;
    }

    Ok(Wallets {
        alice,
        bob,
        mine_to,
        node: root,
    })
}

fn open_wallet(root: &Client, name: &str, fresh: bool) -> Result<()> {
    if fresh {
        root.call::<Value>("createwallet", &[json!(name)])
            .with_context(|| format!("createwallet {name}"))?;
        return Ok(());
    }
    let loaded: Vec<String> = root.call("listwallets", &[])?;
    if loaded.iter().any(|w| w == name) {
        return Ok(());
    }
    root.call::<Value>("loadwallet", &[json!(name)])
        .with_context(|| {
            format!("loadwallet {name}; start with --fresh if the datadir is from another setup")
        })?;
    Ok(())
}

/// Make the wallet's active bech32m descriptor a `cisa()` descriptor over a
/// key made up on the spot, so that every new address, receive and change,
/// is witness version 2.
fn import_cisa_descriptor(wallet: &Client) -> Result<()> {
    let seed: [u8; 32] = rand_seed();
    let xprv = Xpriv::new_master(Network::Regtest, &seed)?;
    let descriptor = format!("cisa({xprv}/86h/1h/0h/<0;1>/*)");
    let info: Value = wallet.call("getdescriptorinfo", &[json!(descriptor)])?;
    let checksum = info["checksum"]
        .as_str()
        .ok_or_else(|| anyhow!("getdescriptorinfo returned no checksum"))?;
    let imported: Value = wallet.call(
        "importdescriptors",
        &[json!([{
            "desc": format!("{descriptor}#{checksum}"),
            "active": true,
            "timestamp": "now",
        }])],
    )?;
    if imported[0]["success"] != json!(true) {
        bail!("importing the cisa() descriptor failed: {imported}");
    }
    Ok(())
}

fn rand_seed() -> [u8; 32] {
    use bitcoin::secp256k1::rand::RngCore;
    let mut seed = [0u8; 32];
    bitcoin::secp256k1::rand::thread_rng().fill_bytes(&mut seed);
    seed
}

/// Blocks a regtest chain starts with, ten minutes apart and ending now.
///
/// They have to pass a difficulty retarget, at 2016, and leave 100 more for
/// the miner's coins to mature. The explorer estimates block times from the
/// current difficulty epoch; on a chain whose epoch starts at the regtest
/// genesis block of 2011, every estimate says weeks. Spacing the blocks out
/// with mock time gives it a history that reads like a real chain.
const HISTORY: u64 = 2016 + 100;

fn history_start(now: u64) -> u64 {
    now - HISTORY * 600
}

fn mine_history(node: &Client, to: &Address, now: u64) -> Result<()> {
    tracing::info!("mining {HISTORY} blocks of history");
    for i in 1..=HISTORY {
        let time = history_start(now) + i * 600;
        node.call::<Value>("setmocktime", &[json!(time)])?;
        generate(node, 1, to)?;
    }
    node.call::<Value>("setmocktime", &[json!(0)])?;
    Ok(())
}

pub fn new_address(wallet: &Client, kind: &str) -> Result<Address> {
    let address: String = wallet.call("getnewaddress", &[json!(""), json!(kind)])?;
    Ok(address
        .parse::<Address<_>>()?
        .require_network(Network::Regtest)?)
}

pub fn block_count(node: &Client) -> Result<u64> {
    Ok(node.call::<u64>("getblockcount", &[])?)
}

pub fn generate(node: &Client, blocks: u64, to: &Address) -> Result<Vec<String>> {
    Ok(node.call("generatetoaddress", &[json!(blocks), json!(to.to_string())])?)
}

/// Transactions of `block` other than its coinbase.
pub fn block_txids(node: &Client, block: &str) -> Result<Vec<Txid>> {
    let block: Value = node.call("getblock", &[json!(block), json!(1)])?;
    let txids = block["tx"]
        .as_array()
        .ok_or_else(|| anyhow!("getblock returned no transactions"))?;
    txids
        .iter()
        .skip(1)
        .map(|txid| {
            txid.as_str()
                .ok_or_else(|| anyhow!("txid is not a string"))?
                .parse::<Txid>()
                .map_err(Into::into)
        })
        .collect()
}

pub fn datadir_default(root: &Path) -> PathBuf {
    root.join(".data").join("bitcoin")
}

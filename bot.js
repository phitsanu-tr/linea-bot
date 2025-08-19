import 'dotenv/config';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import fetch from 'node-fetch';

//
// === CONFIG SECTION ===
//

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SAFE_WALLET = process.env.SAFE_WALLET;
const WS_RPC_URLS = process.env.WS_RPC_URLS?.split(',').map(s => s.trim());
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHAIN_ID = 59144; // Linea Mainnet

if (!PRIVATE_KEY || !SAFE_WALLET || !WS_RPC_URLS || WS_RPC_URLS.length === 0) {
  console.error('Missing env variables: PRIVATE_KEY, SAFE_WALLET, WS_RPC_URLS');
  process.exit(1);
}

const TOKENS_PATH = path.resolve('./tokens.json');
if (!fs.existsSync(TOKENS_PATH)) {
  console.error('Missing tokens.json file');
  process.exit(1);
}
const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));

//
// === UTILS ===
//

const LOG_FILE = path.resolve('./bot.log');
function log(...args) {
  const msg = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(msg);
  fs.appendFileSync(LOG_FILE, msg + '\n');
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function telegramNotify(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
    });
  } catch (e) {
    log('Telegram notify failed:', e.message);
  }
}

//
// === BLOCK REORGANIZATION HANDLING ===
//

let lastBlockHash = '';
let lastBlockNumber = 0;

async function handleBlockReorganization(blockNumber) {
  try {
    const block = await multiProvider.currentProvider.getBlock(blockNumber);
    if (!block) return;
    
    if (lastBlockHash && block.parentHash !== lastBlockHash && blockNumber > lastBlockNumber) {
      log(`🔄 Chain reorganization detected at block ${blockNumber}`);
      await telegramNotify(`🔄 Chain reorg detected! Rechecking balances...`);
      await delay(5000);
      await recheckAllBalances();
    }
    
    lastBlockHash = block.hash;
    lastBlockNumber = blockNumber;
  } catch (e) {
    log(`Block reorg handling error: ${e.message}`);
  }
}

async function recheckAllBalances() {
  log('🔍 Rechecking all token balances after reorg...');
  
  for (const t of tokens) {
    try {
      const tokenInfo = tokenContracts.get(t.address.toLowerCase());
      if (!tokenInfo) continue;
      
      const balance = await tokenInfo.contract.balanceOf(wallet.address);
      if (balance.gt(0)) {
        log(`💰 Reorg recheck found ${tokenInfo.symbol}: ${ethers.utils.formatUnits(balance, tokenInfo.decimals)}`);
        await instantTransfer(t.address, balance);
      }
    } catch (err) {
      log(`Reorg recheck error for ${t.symbol}: ${err.message}`);
    }
  }
}

//
// === DISABLED MEV PROTECTION ===
//

async function detectSandwichAttack(tokenAddress, ourGasPrice) {
  return { isSandwich: false, count: 0 };
}

async function analyzeMEVCompetition(tokenAddress, ourGasPrice) {
  return { competitors: 0, maxGasPrice: ourGasPrice };
}

function isFlashloanAttack(txReceipt) {
  const eventCount = txReceipt.logs.length;
  const gasUsed = txReceipt.gasUsed;
  return eventCount > 20 || gasUsed.gt(ethers.BigNumber.from(1000000));
}

async function analyzeIncomingTransaction(txHash) {
  return { isFlashloan: false };
}

//
// === CHEAP GAS STRATEGY ===
//

let networkCongestion = 0;

async function getOptimalPriorityFee(provider) {
  try {
    const pendingBlock = await provider.getBlock('pending');
    networkCongestion = pendingBlock.transactions.length;
    
    // ใช้ priority fee ต่ำมาก
    return ethers.utils.parseUnits('0.1', 'gwei'); // 0.1 gwei เท่านั้น
  } catch (e) {
    return ethers.utils.parseUnits('0.1', 'gwei');
  }
}

async function getCompetitiveGasPrice(provider, tokenAddress = null) {
  try {
    const gasPrice = await provider.getGasPrice();
    
    // ใช้ gas price ปกติไม่เพิ่ม multiplier
    return { 
      gasPrice: gasPrice,
      chainId: CHAIN_ID,
      type: 0
    };
  } catch (e) {
    log('Gas price fetch failed:', e.message);
    return { 
      gasPrice: ethers.utils.parseUnits('1', 'gwei'), // 1 gwei fallback
      chainId: CHAIN_ID,
      type: 0 
    };
  }
}

async function estimateGasWithFallback(contract, method, args) {
  try {
    const estimated = await contract.estimateGas[method](...args);
    return estimated; // ไม่เพิ่ม buffer
  } catch (e) {
    log(`Gas estimation failed: ${e.message}, using fallback`);
    return ethers.BigNumber.from(100000); // 100k gas
  }
}

function getMEVProtectionDelay() {
  return Math.floor(Math.random() * 200) + 50; // 50-250ms
}

//
// === OPTIMIZED MULTI-RPC PROVIDER ===
//

class OptimizedMultiRpcProvider extends EventEmitter {
  constructor(urls) {
    super();
    this.urls = urls;
    this.connectionPool = urls.map(url => {
      return Array(2).fill().map(() => new ethers.providers.WebSocketProvider(url)); // ลดจาก 3 เป็น 2
    }).flat();
    this.latencies = new Array(this.connectionPool.length).fill(Infinity);
    this.currentIndex = 0;
    this.healthCheckIntervalMs = 30_000;
    this.healthCheckTimer = null;
    this.init();
  }

  async init() {
    await this.measureLatencies();
    this.selectBestProvider();
    this.setupListeners();
    this.startHealthCheck();
    this.setupBlockListener();
  }

  setupBlockListener() {
    this.currentProvider.on('block', handleBlockReorganization);
  }

  async measureLatency(index) {
    const p = this.connectionPool[index];
    const start = Date.now();
    try {
      await p.getBlockNumber();
      this.latencies[index] = Date.now() - start;
    } catch {
      this.latencies[index] = Infinity;
    }
  }

  async measureLatencies() {
    await Promise.all(this.connectionPool.map((_, i) => this.measureLatency(i)));
  }

  selectBestProvider() {
    const minLatency = Math.min(...this.latencies);
    this.currentIndex = this.latencies.indexOf(minLatency);
    log(`Selected RPC #${this.currentIndex} latency ${this.latencies[this.currentIndex]}ms`);
    this.emit('providerChanged', this.currentProvider);
  }

  get currentProvider() {
    return this.connectionPool[this.currentIndex];
  }

  getRandomProvider() {
    const healthyProviders = this.connectionPool.filter((_, i) => this.latencies[i] < Infinity);
    return healthyProviders[Math.floor(Math.random() * healthyProviders.length)] || this.currentProvider;
  }

  setupListeners() {
    this.connectionPool.forEach((p, i) => {
      p._websocket.on('close', async (code) => {
        log(`RPC #${i} websocket closed with code ${code}`);
        await this.measureLatencies();
        this.selectBestProvider();
      });
      p._websocket.on('error', async (err) => {
        log(`RPC #${i} websocket error: ${err.message}`);
        await this.measureLatencies();
        this.selectBestProvider();
      });
    });
  }

  startHealthCheck() {
    this.healthCheckTimer = setInterval(async () => {
      await this.measureLatencies();
      this.selectBestProvider();
    }, this.healthCheckIntervalMs);
  }

  stopHealthCheck() {
    clearInterval(this.healthCheckTimer);
  }
}

//
// === TOKEN CONTRACT SETUP ===
//

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

let wallet;
let multiProvider;
const tokenContracts = new Map();
const tokenProcessing = new Map();

const preSignedTxs = new Map();
const pendingTxs = new Map();
const TX_REPLACEMENT_TIMEOUT = 30000;

async function prepareCounterTransfer(tokenAddress, expectedAmount) {
  const tokenInfo = tokenContracts.get(tokenAddress.toLowerCase());
  if (!tokenInfo) return;
  
  try {
    const gasConfig = await getCompetitiveGasPrice(multiProvider.currentProvider, tokenAddress);
    const nonce = await wallet.getTransactionCount('pending');
    
    const unsignedTx = await tokenInfo.contract.populateTransaction.transfer(SAFE_WALLET, expectedAmount);
    unsignedTx.gasLimit = await estimateGasWithFallback(tokenInfo.contract, 'transfer', [SAFE_WALLET, expectedAmount]);
    unsignedTx.nonce = nonce;
    Object.assign(unsignedTx, gasConfig);
    
    const signedTx = await wallet.signTransaction(unsignedTx);
    preSignedTxs.set(tokenAddress.toLowerCase(), { 
      signedTx, 
      nonce,
      gasPrice: gasConfig.gasPrice
    });
    
    log(`📝 Pre-signed tx prepared for ${tokenInfo.symbol}`);
  } catch (e) {
    log(`Failed to prepare pre-signed tx for ${tokenAddress}: ${e.message}`);
  }
}

async function setupMempoolMonitoring() {
  log('⚠️ Mempool monitoring disabled (txpool_content not supported)');
}

async function instantTransfer(tokenAddress, amount) {
  const mevDelay = getMEVProtectionDelay();
  log(`🛡️ MEV protection delay: ${mevDelay}ms`);
  await delay(mevDelay);
  
  const preSignedData = preSignedTxs.get(tokenAddress.toLowerCase());
  if (preSignedData) {
    try {
      const txResponse = await multiProvider.getRandomProvider().sendTransaction(preSignedData.signedTx);
      log(`⚡ Instant transfer: ${txResponse.hash}`);
      
      pendingTxs.set(txResponse.hash, {
        tokenAddress,
        amount,
        gasPrice: preSignedData.gasPrice,
        nonce: preSignedData.nonce,
        timestamp: Date.now()
      });
      
      preSignedTxs.delete(tokenAddress.toLowerCase());
      return txResponse;
    } catch (e) {
      log(`Pre-signed tx failed: ${e.message}`);
      preSignedTxs.delete(tokenAddress.toLowerCase());
    }
  }
  
  enqueueTransfer(tokenAddress, amount);
}

async function replaceStuckTransaction(txHash, txData) {
  try {
    const tokenInfo = tokenContracts.get(txData.tokenAddress.toLowerCase());
    if (!tokenInfo) return;
    
    log(`🔄 Replacing stuck transaction: ${txHash}`);
    
    // เพิ่ม gas price เพียง 10%
    const newGasPrice = txData.gasPrice.mul(110).div(100);
    
    const unsignedTx = await tokenInfo.contract.populateTransaction.transfer(SAFE_WALLET, txData.amount);
    const gasLimit = await estimateGasWithFallback(tokenInfo.contract, 'transfer', [SAFE_WALLET, txData.amount]);
    
    unsignedTx.gasLimit = gasLimit;
    unsignedTx.nonce = txData.nonce;
    unsignedTx.chainId = CHAIN_ID;
    unsignedTx.gasPrice = newGasPrice;
    
    const signedTx = await wallet.signTransaction(unsignedTx);
    const newTxResponse = await multiProvider.getRandomProvider().sendTransaction(signedTx);
    
    log(`✅ Replacement tx sent: ${newTxResponse.hash}`);
    
    pendingTxs.delete(txHash);
    pendingTxs.set(newTxResponse.hash, {
      ...txData,
      gasPrice: newGasPrice,
      timestamp: Date.now()
    });
    
    return newTxResponse;
  } catch (e) {
    log(`❌ Failed to replace transaction: ${e.message}`);
  }
}

setInterval(async () => {
  const now = Date.now();
  for (const [txHash, txData] of pendingTxs.entries()) {
    if (now - txData.timestamp > TX_REPLACEMENT_TIMEOUT) {
      try {
        const receipt = await multiProvider.currentProvider.getTransactionReceipt(txHash);
        if (!receipt) {
          await replaceStuckTransaction(txHash, txData);
        } else {
          if (isFlashloanAttack(receipt)) {
            log(`🚨 Flashloan detected in confirmed tx: ${txHash}`);
            await telegramNotify(`🚨 Flashloan confirmed in tx: ${txHash}`);
          }
          pendingTxs.delete(txHash);
        }
      } catch (e) {
        await replaceStuckTransaction(txHash, txData);
      }
    }
  }
}, 15000);

async function setupFastEventListening() {
  for (const [address, tokenInfo] of tokenContracts) {
    multiProvider.connectionPool.forEach((provider, index) => {
      const contract = new ethers.Contract(address, ERC20_ABI, provider);
      contract.on('Transfer', async (from, to, value) => {
        if (to.toLowerCase() === wallet.address.toLowerCase()) {
          log(`📥 Fast event #${index}: ${tokenInfo.symbol} amount: ${ethers.utils.formatUnits(value, tokenInfo.decimals)}`);
          await instantTransfer(address, value);
        }
      });
    });
  }
}

async function setupContracts() {
  tokenContracts.clear();
  tokenProcessing.clear();

  for (const t of tokens) {
    const contract = new ethers.Contract(t.address, ERC20_ABI, wallet);
    tokenContracts.set(t.address.toLowerCase(), { contract, decimals: t.decimals, symbol: t.symbol });
    tokenProcessing.set(t.address.toLowerCase(), false);
  }
  
  await setupFastEventListening();
}

//
// === PRIORITY QUEUE + NONCE MANAGEMENT ===
//

class TxQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.nonce = null;
  }

  async initNonce() {
    this.nonce = await wallet.getTransactionCount('pending');
  }

  enqueue(job) {
    this.queue.push(job);
    if (!this.processing) {
      this.process();
    }
  }

  async process() {
    this.processing = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      await transferWithRetry(job.tokenAddress, job.amount);
    }
    this.processing = false;
  }
}

const txQueue = new TxQueue();

function enqueueTransfer(tokenAddress, amount) {
  txQueue.enqueue({ tokenAddress: tokenAddress.toLowerCase(), amount });
}

//
// === TRANSFER WITH RETRY ===
//

async function transferWithRetry(tokenAddress, amount) {
  if (tokenProcessing.get(tokenAddress)) return;
  tokenProcessing.set(tokenAddress, true);

  const tokenInfo = tokenContracts.get(tokenAddress);
  if (!tokenInfo) {
    log(`Token contract not found for ${tokenAddress}`);
    tokenProcessing.set(tokenAddress, false);
    return;
  }
  const { contract, decimals, symbol } = tokenInfo;

  if (!txQueue.nonce) {
    await txQueue.initNonce();
  }

  let nonce = txQueue.nonce;
  const maxRetries = 5;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;

    try {
      const balance = await contract.balanceOf(wallet.address);
      const sendAmount = amount.gt(balance) ? balance : amount;
      if (sendAmount.isZero()) {
        log(`❌ ${symbol} balance is zero, skipping transfer`);
        tokenProcessing.set(tokenAddress, false);
        return false;
      }

      // ตรวจสอบ ETH balance ก่อนส่ง
      const ethBalance = await wallet.getBalance();
      const gasConfig = await getCompetitiveGasPrice(multiProvider.currentProvider, tokenAddress);
      const gasLimit = await estimateGasWithFallback(contract, 'transfer', [SAFE_WALLET, sendAmount]);
      const estimatedCost = gasConfig.gasPrice.mul(gasLimit);
      
      if (ethBalance.lt(estimatedCost)) {
        log(`❌ Insufficient ETH! Need: ${ethers.utils.formatEther(estimatedCost)} ETH, Have: ${ethers.utils.formatEther(ethBalance)} ETH`);
        await telegramNotify(`❌ Insufficient ETH! Need: ${ethers.utils.formatEther(estimatedCost)} ETH`);
        tokenProcessing.set(tokenAddress, false);
        return false;
      }

      const unsignedTx = await contract.populateTransaction.transfer(SAFE_WALLET, sendAmount);
      unsignedTx.gasLimit = gasLimit;
      unsignedTx.nonce = nonce;
      Object.assign(unsignedTx, gasConfig);

      const signedTx = await wallet.signTransaction(unsignedTx);
      const txResponse = await multiProvider.getRandomProvider().sendTransaction(signedTx);

      log(`✅ Sent ${symbol} tx: ${txResponse.hash} attempt ${attempt} nonce ${nonce}`);
      
      pendingTxs.set(txResponse.hash, {
        tokenAddress,
        amount: sendAmount,
        gasPrice: gasConfig.gasPrice,
        nonce,
        timestamp: Date.now()
      });

      await txResponse.wait(1);
      
      pendingTxs.delete(txResponse.hash);

      log(`✅ Confirmed ${symbol} transfer tx: ${txResponse.hash}`);

      nonce++;
      txQueue.nonce = nonce;

      tokenProcessing.set(tokenAddress, false);

      await telegramNotify(`✅ Transfer success: ${symbol} ${ethers.utils.formatUnits(sendAmount, decimals)} TX: ${txResponse.hash}`);

      return true;
    } catch (err) {
      log(`⚠️ Transfer attempt ${attempt} failed for ${symbol}: ${err.message}`);

      if (err.message.includes('nonce too low')) {
        nonce = await wallet.getTransactionCount('pending');
        txQueue.nonce = nonce;
      } else if (err.message.includes('insufficient funds')) {
        log(`❌ Insufficient ETH for gas!`);
        await telegramNotify(`❌ Insufficient ETH for gas!`);
        tokenProcessing.set(tokenAddress, false);
        return false;
      }

      nonce++;
      txQueue.nonce = nonce;

      await delay(2 ** attempt * 1000);
    }
  }

  log(`❌ Failed to transfer ${symbol} after ${maxRetries} attempts`);
  tokenProcessing.set(tokenAddress, false);
  await telegramNotify(`❌ Failed to transfer ${symbol} after ${maxRetries} attempts`);
  return false;
}

//
// === AGGRESSIVE POLLING ===
//

async function aggressivePolling() {
  const promises = tokens.map(async (t) => {
    try {
      const tokenInfo = tokenContracts.get(t.address.toLowerCase());
      if (!tokenInfo) return;

      const balance = await tokenInfo.contract.balanceOf(wallet.address);
      if (balance.gt(0)) {
        log(`⌚ Aggressive poll detected ${tokenInfo.symbol} balance: ${ethers.utils.formatUnits(balance, tokenInfo.decimals)}`);
        await instantTransfer(t.address, balance);
      }
    } catch (err) {
      log(`Aggressive polling error for ${t.symbol}: ${err.message}`);
    }
  });
  
  await Promise.all(promises);
}

async function startAggressivePolling() {
  while (true) {
    await aggressivePolling();
    await delay(100);
  }
}

//
// === START BOT ===
//

(async () => {
  multiProvider = new OptimizedMultiRpcProvider(WS_RPC_URLS);

  multiProvider.on('providerChanged', (newProvider) => {
    log(`Provider switched to: ${newProvider.connection.url}`);
    wallet = new ethers.Wallet(PRIVATE_KEY, newProvider);
    setupContracts().catch(e => log('Setup contracts error:', e.message));
    txQueue.nonce = null;
    
    newProvider.on('block', handleBlockReorganization);
  });

  wallet = new ethers.Wallet(PRIVATE_KEY, multiProvider.currentProvider);
  await setupContracts();
  await txQueue.initNonce();

  await setupMempoolMonitoring();

  log(`🚀 Ultimate Bot started on wallet: ${wallet.address}`);
  log(`💰 ETH Balance: ${ethers.utils.formatEther(await wallet.getBalance())} ETH`);
  log(`🛡️ MEV Protection: LIMITED (mempool disabled)`);
  log(`⚡ Gas Strategy: CHEAP (no multipliers)`);
  log(`🔄 Transaction Replacement: ON`);
  log(`🚨 Flashloan Detection: ON`);
  log(`⛓️ Chain ID: ${CHAIN_ID} (Linea)`);

  startAggressivePolling();

  process.on('SIGINT', () => {
    log('Received SIGINT, exiting...');
    multiProvider.stopHealthCheck();
    process.exit();
  });
  process.on('SIGTERM', () => {
    log('Received SIGTERM, exiting...');
    multiProvider.stopHealthCheck();
    process.exit();
  });
})();

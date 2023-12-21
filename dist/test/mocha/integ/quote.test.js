import { AllowanceTransfer } from '@uniswap/permit2-sdk';
import { ChainId, CurrencyAmount, Ether, Fraction, Rounding, Token, WETH9 } from '@uniswap/sdk-core';
import { CEUR_CELO, CEUR_CELO_ALFAJORES, CUSD_CELO, CUSD_CELO_ALFAJORES, DAI_MAINNET, ID_TO_NETWORK_NAME, NATIVE_CURRENCY, parseAmount, SWAP_ROUTER_02_ADDRESSES, USDC_MAINNET, USDT_MAINNET, WBTC_MAINNET, } from '@uniswap/smart-order-router';
import { PERMIT2_ADDRESS, UNIVERSAL_ROUTER_ADDRESS as UNIVERSAL_ROUTER_ADDRESS_BY_CHAIN, } from '@uniswap/universal-router-sdk';
import { fail } from 'assert';
import axiosStatic from 'axios';
import axiosRetry from 'axios-retry';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import { BigNumber, Wallet } from 'ethers';
import hre from 'hardhat';
import _ from 'lodash';
import qs from 'qs';
import { SUPPORTED_CHAINS } from '../../../lib/handlers/injector-sor';
import { Permit2__factory } from '../../../lib/types/ext';
import { resetAndFundAtBlock } from '../../utils/forkAndFund';
import { getBalance, getBalanceAndApprove } from '../../utils/getBalanceAndApprove';
import { DAI_ON, getAmount, getAmountFromToken, UNI_MAINNET, USDC_ON, USDT_ON, WNATIVE_ON } from '../../utils/tokens';
import { FLAT_PORTION, GREENLIST_TOKEN_PAIRS } from '../../test-utils/mocked-data';
const { ethers } = hre;
chai.use(chaiAsPromised);
chai.use(chaiSubset);
const UNIVERSAL_ROUTER_ADDRESS = UNIVERSAL_ROUTER_ADDRESS_BY_CHAIN(1);
if (!process.env.UNISWAP_ROUTING_API || !process.env.ARCHIVE_NODE_RPC) {
    throw new Error('Must set UNISWAP_ROUTING_API and ARCHIVE_NODE_RPC env variables for integ tests. See README');
}
const API = `${process.env.UNISWAP_ROUTING_API}quote`;
const SLIPPAGE = '5';
const LARGE_SLIPPAGE = '20';
const BULLET = new Token(ChainId.MAINNET, '0x8ef32a03784c8Fd63bBf027251b9620865bD54B6', 8, 'BULLET', 'Bullet Game Betting Token');
const BULLET_WHT_TAX = new Token(ChainId.MAINNET, '0x8ef32a03784c8Fd63bBf027251b9620865bD54B6', 8, 'BULLET', 'Bullet Game Betting Token', false, BigNumber.from(500), BigNumber.from(500));
const axios = axiosStatic.create();
axiosRetry(axios, {
    retries: 10,
    retryCondition: (err) => { var _a; return ((_a = err.response) === null || _a === void 0 ? void 0 : _a.status) == 429; },
    retryDelay: axiosRetry.exponentialDelay,
});
const callAndExpectFail = async (quoteReq, resp) => {
    const queryParams = qs.stringify(quoteReq);
    try {
        await axios.get(`${API}?${queryParams}`);
        fail();
    }
    catch (err) {
        expect(err.response).to.containSubset(resp);
    }
};
const checkQuoteToken = (before, after, tokensQuoted) => {
    // Check which is bigger to support exactIn and exactOut
    const tokensSwapped = after.greaterThan(before) ? after.subtract(before) : before.subtract(after);
    const tokensDiff = tokensQuoted.greaterThan(tokensSwapped)
        ? tokensQuoted.subtract(tokensSwapped)
        : tokensSwapped.subtract(tokensQuoted);
    const percentDiff = tokensDiff.asFraction.divide(tokensQuoted.asFraction);
    expect(percentDiff.lessThan(new Fraction(parseInt(SLIPPAGE), 100))).to.be.true;
};
const checkPortionRecipientToken = (before, after, expectedPortionAmountReceived) => {
    const actualPortionAmountReceived = after.subtract(before);
    const tokensDiff = expectedPortionAmountReceived.greaterThan(actualPortionAmountReceived)
        ? expectedPortionAmountReceived.subtract(actualPortionAmountReceived)
        : actualPortionAmountReceived.subtract(expectedPortionAmountReceived);
    // There will be a slight difference between expected and actual due to slippage during the hardhat fork swap.
    const percentDiff = tokensDiff.asFraction.divide(expectedPortionAmountReceived.asFraction);
    expect(percentDiff.lessThan(new Fraction(parseInt(SLIPPAGE), 100))).to.be.true;
};
let warnedTesterPK = false;
const isTesterPKEnvironmentSet = () => {
    const isSet = !!process.env.TESTER_PK;
    if (!isSet && !warnedTesterPK) {
        console.log('Skipping tests requiring real PK since env variables for TESTER_PK is not set.');
        warnedTesterPK = true;
    }
    return isSet;
};
const MAX_UINT160 = '0xffffffffffffffffffffffffffffffffffffffff';
describe('quote', function () {
    // Help with test flakiness by retrying.
    this.retries(0);
    this.timeout('500s');
    let alice;
    let block;
    let curNonce = 0;
    let nextPermitNonce = () => {
        const nonce = curNonce.toString();
        curNonce = curNonce + 1;
        return nonce;
    };
    const executeSwap = async (methodParameters, currencyIn, currencyOut, permit, chainId = ChainId.MAINNET, portion) => {
        const permit2 = Permit2__factory.connect(PERMIT2_ADDRESS, alice);
        const portionRecipientSigner = (portion === null || portion === void 0 ? void 0 : portion.recipient) ? await ethers.getSigner(portion === null || portion === void 0 ? void 0 : portion.recipient) : undefined;
        // Approve Permit2
        const tokenInBefore = await getBalanceAndApprove(alice, PERMIT2_ADDRESS, currencyIn);
        const tokenOutBefore = await getBalance(alice, currencyOut);
        const tokenOutPortionRecipientBefore = portionRecipientSigner
            ? await getBalance(portionRecipientSigner, currencyOut)
            : undefined;
        // Approve SwapRouter02 in case we request calldata for it instead of Universal Router
        await getBalanceAndApprove(alice, SWAP_ROUTER_02_ADDRESSES(chainId), currencyIn);
        // If not using permit do a regular approval allowing narwhal max balance.
        if (!permit) {
            const approveNarwhal = await permit2.approve(currencyIn.wrapped.address, UNIVERSAL_ROUTER_ADDRESS, MAX_UINT160, 100000000000000);
            await approveNarwhal.wait();
        }
        const transaction = {
            data: methodParameters.calldata,
            to: methodParameters.to,
            value: BigNumber.from(methodParameters.value),
            from: alice.address,
            gasPrice: BigNumber.from(2000000000000),
            type: 1,
        };
        const transactionResponse = await alice.sendTransaction(transaction);
        await transactionResponse.wait();
        const tokenInAfter = await getBalance(alice, currencyIn);
        const tokenOutAfter = await getBalance(alice, currencyOut);
        const tokenOutPortionRecipientAfter = portionRecipientSigner
            ? await getBalance(portionRecipientSigner, currencyOut)
            : undefined;
        return {
            tokenInAfter,
            tokenInBefore,
            tokenOutAfter,
            tokenOutBefore,
            tokenOutPortionRecipientBefore,
            tokenOutPortionRecipientAfter,
        };
    };
    before(async function () {
        this.timeout(40000);
        [alice] = await ethers.getSigners();
        // Make a dummy call to the API to get a block number to fork from.
        const quoteReq = {
            tokenInAddress: 'USDC',
            tokenInChainId: 1,
            tokenOutAddress: 'USDT',
            tokenOutChainId: 1,
            amount: await getAmount(1, 'exactIn', 'USDC', 'USDT', '100'),
            type: 'exactIn',
        };
        const { data: { blockNumber }, } = await axios.get(`${API}?${qs.stringify(quoteReq)}`);
        block = parseInt(blockNumber) - 10;
        alice = await resetAndFundAtBlock(alice, block, [
            parseAmount('8000000', USDC_MAINNET),
            parseAmount('5000000', USDT_MAINNET),
            parseAmount('10', WBTC_MAINNET),
            parseAmount('1000', UNI_MAINNET),
            parseAmount('4000', WETH9[1]),
            parseAmount('5000000', DAI_MAINNET),
            parseAmount('735871', BULLET),
        ]);
        // alice should always have 10000 ETH
        const aliceEthBalance = await getBalance(alice, Ether.onChain(1));
        /// Since alice is deploying the QuoterV3 contract, expect to have slightly less than 10_000 ETH but not too little
        expect(!aliceEthBalance.lessThan(CurrencyAmount.fromRawAmount(Ether.onChain(1), '9995'))).to.be.true;
        // for all other balance checks, we ensure they are at least X amount. There's a possibility for more than X token amount,
        // due to a single whale address being whale for more than one token.
        const aliceUSDCBalance = await getBalance(alice, USDC_MAINNET);
        expect(!aliceUSDCBalance.lessThan(parseAmount('8000000', USDC_MAINNET))).to.be.true;
        const aliceUSDTBalance = await getBalance(alice, USDT_MAINNET);
        expect(!aliceUSDTBalance.lessThan(parseAmount('5000000', USDT_MAINNET))).to.be.true;
        const aliceWETH9Balance = await getBalance(alice, WETH9[1]);
        expect(!aliceWETH9Balance.lessThan(parseAmount('4000', WETH9[1]))).to.be.true;
        const aliceWBTCBalance = await getBalance(alice, WBTC_MAINNET);
        expect(!aliceWBTCBalance.lessThan(parseAmount('10', WBTC_MAINNET))).to.be.true;
        const aliceDAIBalance = await getBalance(alice, DAI_MAINNET);
        expect(!aliceDAIBalance.lessThan(parseAmount('5000000', DAI_MAINNET))).to.be.true;
        const aliceUNIBalance = await getBalance(alice, UNI_MAINNET);
        expect(!aliceUNIBalance.lessThan(parseAmount('1000', UNI_MAINNET))).to.be.true;
        const aliceBULLETBalance = await getBalance(alice, BULLET);
        expect(!aliceBULLETBalance.lessThan(parseAmount('735871', BULLET))).to.be.true;
    });
    for (const algorithm of ['alpha']) {
        for (const type of ['exactIn', 'exactOut']) {
            describe(`${ID_TO_NETWORK_NAME(1)} ${algorithm} ${type} 2xx`, () => {
                describe(`+ Execute Swap`, () => {
                    it(`erc20 -> erc20`, async () => {
                        const quoteReq = {
                            tokenInAddress: 'USDC',
                            tokenInChainId: 1,
                            tokenOutAddress: 'USDT',
                            tokenOutChainId: 1,
                            amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                            type,
                            recipient: alice.address,
                            slippageTolerance: SLIPPAGE,
                            deadline: '360',
                            algorithm,
                            enableUniversalRouter: true,
                        };
                        const queryParams = qs.stringify(quoteReq);
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data: { quote, quoteDecimals, quoteGasAdjustedDecimals, methodParameters }, status, } = response;
                        expect(status).to.equal(200);
                        expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                        expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                        if (type == 'exactIn') {
                            expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                        }
                        else {
                            expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                        }
                        expect(methodParameters).to.not.be.undefined;
                        expect(methodParameters === null || methodParameters === void 0 ? void 0 : methodParameters.to).to.equal(UNIVERSAL_ROUTER_ADDRESS);
                        const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(methodParameters, USDC_MAINNET, USDT_MAINNET);
                        if (type == 'exactIn') {
                            expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(USDT_MAINNET, quote));
                        }
                        else {
                            expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                            checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote));
                        }
                    });
                    it(`erc20 -> erc20 swaprouter02`, async () => {
                        const quoteReq = {
                            tokenInAddress: 'USDC',
                            tokenInChainId: 1,
                            tokenOutAddress: 'USDT',
                            tokenOutChainId: 1,
                            amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                            type,
                            recipient: alice.address,
                            slippageTolerance: SLIPPAGE,
                            deadline: '360',
                            algorithm,
                        };
                        const queryParams = qs.stringify(quoteReq);
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data: { quote, quoteDecimals, quoteGasAdjustedDecimals, methodParameters }, status, } = response;
                        expect(status).to.equal(200);
                        expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                        expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                        if (type == 'exactIn') {
                            expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                        }
                        else {
                            expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                        }
                        expect(methodParameters).to.not.be.undefined;
                        expect(methodParameters === null || methodParameters === void 0 ? void 0 : methodParameters.to).to.equal(SWAP_ROUTER_02_ADDRESSES(ChainId.MAINNET));
                        const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(methodParameters, USDC_MAINNET, USDT_MAINNET);
                        if (type == 'exactIn') {
                            expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(USDT_MAINNET, quote));
                        }
                        else {
                            expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                            checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote));
                        }
                    });
                    it(`erc20 -> erc20 with permit`, async () => {
                        const amount = await getAmount(1, type, 'USDC', 'USDT', '10');
                        const nonce = nextPermitNonce();
                        const permit = {
                            details: {
                                token: USDC_MAINNET.address,
                                amount: '15000000',
                                expiration: Math.floor(new Date().getTime() / 1000 + 10000000).toString(),
                                nonce,
                            },
                            spender: UNIVERSAL_ROUTER_ADDRESS,
                            sigDeadline: Math.floor(new Date().getTime() / 1000 + 10000000).toString(),
                        };
                        const { domain, types, values } = AllowanceTransfer.getPermitData(permit, PERMIT2_ADDRESS, 1);
                        const signature = await alice._signTypedData(domain, types, values);
                        const quoteReq = {
                            tokenInAddress: 'USDC',
                            tokenInChainId: 1,
                            tokenOutAddress: 'USDT',
                            tokenOutChainId: 1,
                            amount,
                            type,
                            recipient: alice.address,
                            slippageTolerance: SLIPPAGE,
                            deadline: '360',
                            algorithm,
                            permitSignature: signature,
                            permitAmount: permit.details.amount.toString(),
                            permitExpiration: permit.details.expiration.toString(),
                            permitSigDeadline: permit.sigDeadline.toString(),
                            permitNonce: permit.details.nonce.toString(),
                            enableUniversalRouter: true,
                        };
                        const queryParams = qs.stringify(quoteReq);
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data: { quote, quoteDecimals, quoteGasAdjustedDecimals, methodParameters }, status, } = response;
                        expect(status).to.equal(200);
                        expect(parseFloat(quoteDecimals)).to.be.greaterThan(9);
                        expect(parseFloat(quoteDecimals)).to.be.lessThan(11);
                        if (type == 'exactIn') {
                            expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                        }
                        else {
                            expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                        }
                        expect(methodParameters).to.not.be.undefined;
                        expect(methodParameters === null || methodParameters === void 0 ? void 0 : methodParameters.to).to.equal(UNIVERSAL_ROUTER_ADDRESS);
                        const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(methodParameters, USDC_MAINNET, USDT_MAINNET, true);
                        if (type == 'exactIn') {
                            expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('10');
                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(USDT_MAINNET, quote));
                        }
                        else {
                            expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('10');
                            checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote));
                        }
                    });
                    it(`erc20 -> eth`, async () => {
                        const quoteReq = {
                            tokenInAddress: 'USDC',
                            tokenInChainId: 1,
                            tokenOutAddress: 'ETH',
                            tokenOutChainId: 1,
                            amount: await getAmount(1, type, 'USDC', 'ETH', type == 'exactIn' ? '1000000' : '10'),
                            type,
                            recipient: alice.address,
                            slippageTolerance: SLIPPAGE,
                            deadline: '360',
                            algorithm,
                            enableUniversalRouter: true,
                        };
                        const queryParams = qs.stringify(quoteReq);
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data: { quote, methodParameters }, status, } = response;
                        expect(status).to.equal(200);
                        expect(methodParameters).to.not.be.undefined;
                        const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(methodParameters, USDC_MAINNET, Ether.onChain(1));
                        if (type == 'exactIn') {
                            expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('1000000');
                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(Ether.onChain(1), quote));
                        }
                        else {
                            // Hard to test ETH balance due to gas costs for approval and swap. Just check tokenIn changes
                            checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote));
                        }
                    });
                    it(`erc20 -> eth large trade`, async () => {
                        // Trade of this size almost always results in splits.
                        const quoteReq = {
                            tokenInAddress: 'USDC',
                            tokenInChainId: 1,
                            tokenOutAddress: 'ETH',
                            tokenOutChainId: 1,
                            amount: type == 'exactIn'
                                ? await getAmount(1, type, 'USDC', 'ETH', '1000000')
                                : await getAmount(1, type, 'USDC', 'ETH', '100'),
                            type,
                            recipient: alice.address,
                            slippageTolerance: SLIPPAGE,
                            deadline: '360',
                            algorithm,
                            enableUniversalRouter: true,
                        };
                        const queryParams = qs.stringify(quoteReq);
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data, status } = response;
                        expect(status).to.equal(200);
                        expect(data.methodParameters).to.not.be.undefined;
                        expect(data.route).to.not.be.undefined;
                        const amountInEdgesTotal = _(data.route)
                            .flatMap((route) => route[0])
                            .filter((pool) => !!pool.amountIn)
                            .map((pool) => BigNumber.from(pool.amountIn))
                            .reduce((cur, total) => total.add(cur), BigNumber.from(0));
                        const amountIn = BigNumber.from(data.quote);
                        expect(amountIn.eq(amountInEdgesTotal));
                        const amountOutEdgesTotal = _(data.route)
                            .flatMap((route) => route[0])
                            .filter((pool) => !!pool.amountOut)
                            .map((pool) => BigNumber.from(pool.amountOut))
                            .reduce((cur, total) => total.add(cur), BigNumber.from(0));
                        const amountOut = BigNumber.from(data.quote);
                        expect(amountOut.eq(amountOutEdgesTotal));
                        const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, USDC_MAINNET, Ether.onChain(1));
                        if (type == 'exactIn') {
                            expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('1000000');
                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(Ether.onChain(1), data.quote));
                        }
                        else {
                            // Hard to test ETH balance due to gas costs for approval and swap. Just check tokenIn changes
                            checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, data.quote));
                        }
                    });
                    it(`erc20 -> eth large trade with permit`, async () => {
                        const nonce = nextPermitNonce();
                        const amount = type == 'exactIn'
                            ? await getAmount(1, type, 'USDC', 'ETH', '1000000')
                            : await getAmount(1, type, 'USDC', 'ETH', '100');
                        const permit = {
                            details: {
                                token: USDC_MAINNET.address,
                                amount: '1500000000000',
                                expiration: Math.floor(new Date().getTime() / 1000 + 10000000).toString(),
                                nonce,
                            },
                            spender: UNIVERSAL_ROUTER_ADDRESS,
                            sigDeadline: Math.floor(new Date().getTime() / 1000 + 10000000).toString(),
                        };
                        const { domain, types, values } = AllowanceTransfer.getPermitData(permit, PERMIT2_ADDRESS, 1);
                        const signature = await alice._signTypedData(domain, types, values);
                        // Trade of this size almost always results in splits.
                        const quoteReq = {
                            tokenInAddress: 'USDC',
                            tokenInChainId: 1,
                            tokenOutAddress: 'ETH',
                            tokenOutChainId: 1,
                            amount,
                            type,
                            recipient: alice.address,
                            slippageTolerance: SLIPPAGE,
                            deadline: '360',
                            algorithm,
                            permitSignature: signature,
                            permitAmount: permit.details.amount.toString(),
                            permitExpiration: permit.details.expiration.toString(),
                            permitSigDeadline: permit.sigDeadline.toString(),
                            permitNonce: permit.details.nonce.toString(),
                            enableUniversalRouter: true,
                        };
                        const queryParams = qs.stringify(quoteReq);
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data, status } = response;
                        expect(status).to.equal(200);
                        expect(data.methodParameters).to.not.be.undefined;
                        expect(data.route).to.not.be.undefined;
                        const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, USDC_MAINNET, Ether.onChain(1), true);
                        if (type == 'exactIn') {
                            expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('1000000');
                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(Ether.onChain(1), data.quote));
                        }
                        else {
                            // Hard to test ETH balance due to gas costs for approval and swap. Just check tokenIn changes
                            checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, data.quote));
                        }
                    });
                    it(`eth -> erc20`, async () => {
                        const quoteReq = {
                            tokenInAddress: 'ETH',
                            tokenInChainId: 1,
                            tokenOutAddress: 'UNI',
                            tokenOutChainId: 1,
                            amount: type == 'exactIn'
                                ? await getAmount(1, type, 'ETH', 'UNI', '10')
                                : await getAmount(1, type, 'ETH', 'UNI', '10000'),
                            type,
                            recipient: alice.address,
                            slippageTolerance: SLIPPAGE,
                            deadline: '360',
                            algorithm,
                            enableUniversalRouter: true,
                        };
                        const queryParams = qs.stringify(quoteReq);
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data, status } = response;
                        expect(status).to.equal(200);
                        expect(data.methodParameters).to.not.be.undefined;
                        const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, Ether.onChain(1), UNI_MAINNET);
                        if (type == 'exactIn') {
                            // We've swapped 10 ETH + gas costs
                            expect(tokenInBefore.subtract(tokenInAfter).greaterThan(parseAmount('10', Ether.onChain(1)))).to.be.true;
                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(UNI_MAINNET, data.quote));
                        }
                        else {
                            expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('10000');
                            // Can't easily check slippage for ETH due to gas costs effecting ETH balance.
                        }
                    });
                    it(`eth -> erc20 swaprouter02`, async () => {
                        var _a;
                        const quoteReq = {
                            tokenInAddress: 'ETH',
                            tokenInChainId: 1,
                            tokenOutAddress: 'UNI',
                            tokenOutChainId: 1,
                            amount: type == 'exactIn'
                                ? await getAmount(1, type, 'ETH', 'UNI', '10')
                                : await getAmount(1, type, 'ETH', 'UNI', '10000'),
                            type,
                            recipient: alice.address,
                            slippageTolerance: type == 'exactOut' ? LARGE_SLIPPAGE : SLIPPAGE,
                            deadline: '360',
                            algorithm,
                            enableUniversalRouter: false,
                        };
                        const queryParams = qs.stringify(quoteReq);
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data, status } = response;
                        expect(status).to.equal(200);
                        expect(data.methodParameters).to.not.be.undefined;
                        expect((_a = data.methodParameters) === null || _a === void 0 ? void 0 : _a.to).to.equal(SWAP_ROUTER_02_ADDRESSES(ChainId.MAINNET));
                        const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, Ether.onChain(1), UNI_MAINNET);
                        if (type == 'exactIn') {
                            // We've swapped 10 ETH + gas costs
                            expect(tokenInBefore.subtract(tokenInAfter).greaterThan(parseAmount('10', Ether.onChain(1)))).to.be.true;
                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(UNI_MAINNET, data.quote));
                        }
                        else {
                            expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('10000');
                            // Can't easily check slippage for ETH due to gas costs effecting ETH balance.
                        }
                    });
                    it(`weth -> erc20`, async () => {
                        const quoteReq = {
                            tokenInAddress: 'WETH',
                            tokenInChainId: 1,
                            tokenOutAddress: 'DAI',
                            tokenOutChainId: 1,
                            amount: await getAmount(1, type, 'WETH', 'DAI', '100'),
                            type,
                            recipient: alice.address,
                            slippageTolerance: SLIPPAGE,
                            deadline: '360',
                            algorithm,
                            enableUniversalRouter: true,
                        };
                        const queryParams = qs.stringify(quoteReq);
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data, status } = response;
                        expect(status).to.equal(200);
                        expect(data.methodParameters).to.not.be.undefined;
                        const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, WETH9[1], DAI_MAINNET);
                        if (type == 'exactIn') {
                            expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(DAI_MAINNET, data.quote));
                        }
                        else {
                            expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                            checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(WETH9[1], data.quote));
                        }
                    });
                    it(`erc20 -> weth`, async () => {
                        const quoteReq = {
                            tokenInAddress: 'USDC',
                            tokenInChainId: 1,
                            tokenOutAddress: 'WETH',
                            tokenOutChainId: 1,
                            amount: await getAmount(1, type, 'USDC', 'WETH', '100'),
                            type,
                            recipient: alice.address,
                            slippageTolerance: SLIPPAGE,
                            deadline: '360',
                            algorithm,
                            enableUniversalRouter: true,
                        };
                        const queryParams = qs.stringify(quoteReq);
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data, status } = response;
                        expect(status).to.equal(200);
                        expect(data.methodParameters).to.not.be.undefined;
                        const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, USDC_MAINNET, WETH9[1]);
                        if (type == 'exactIn') {
                            expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(WETH9[1], data.quote));
                        }
                        else {
                            expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                            checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, data.quote));
                        }
                    });
                    if (algorithm == 'alpha') {
                        it(`erc20 -> erc20 v3 only`, async () => {
                            const quoteReq = {
                                tokenInAddress: 'USDC',
                                tokenInChainId: 1,
                                tokenOutAddress: 'USDT',
                                tokenOutChainId: 1,
                                amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: SLIPPAGE,
                                deadline: '360',
                                algorithm: 'alpha',
                                protocols: 'v3',
                                enableUniversalRouter: true,
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data: { quote, quoteDecimals, quoteGasAdjustedDecimals, methodParameters, route }, status, } = response;
                            expect(status).to.equal(200);
                            expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                            expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                            if (type == 'exactIn') {
                                expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                            }
                            else {
                                expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                            }
                            expect(methodParameters).to.not.be.undefined;
                            for (const r of route) {
                                for (const pool of r) {
                                    expect(pool.type).to.equal('v3-pool');
                                }
                            }
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(response.data.methodParameters, USDC_MAINNET, USDT_MAINNET);
                            if (type == 'exactIn') {
                                expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(USDT_MAINNET, quote));
                            }
                            else {
                                expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                                checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote));
                            }
                        });
                        it(`erc20 -> erc20 v2 only`, async () => {
                            const quoteReq = {
                                tokenInAddress: 'USDC',
                                tokenInChainId: 1,
                                tokenOutAddress: 'USDT',
                                tokenOutChainId: 1,
                                amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: SLIPPAGE,
                                deadline: '360',
                                algorithm: 'alpha',
                                protocols: 'v2',
                                enableUniversalRouter: true,
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data: { quote, quoteDecimals, quoteGasAdjustedDecimals, methodParameters, route }, status, } = response;
                            expect(status).to.equal(200);
                            expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                            expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                            if (type == 'exactIn') {
                                expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                            }
                            else {
                                expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                            }
                            expect(methodParameters).to.not.be.undefined;
                            for (const r of route) {
                                for (const pool of r) {
                                    expect(pool.type).to.equal('v2-pool');
                                }
                            }
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(response.data.methodParameters, USDC_MAINNET, USDT_MAINNET);
                            if (type == 'exactIn') {
                                expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(USDT_MAINNET, quote));
                            }
                            else {
                                expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                                checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote));
                            }
                        });
                        it(`erc20 -> erc20 forceCrossProtocol`, async () => {
                            const quoteReq = {
                                tokenInAddress: 'USDC',
                                tokenInChainId: 1,
                                tokenOutAddress: 'USDT',
                                tokenOutChainId: 1,
                                amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: SLIPPAGE,
                                deadline: '360',
                                algorithm: 'alpha',
                                forceCrossProtocol: true,
                                enableUniversalRouter: true,
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data: { quote, quoteDecimals, quoteGasAdjustedDecimals, methodParameters, route }, status, } = response;
                            expect(status).to.equal(200);
                            expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                            expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                            if (type == 'exactIn') {
                                expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                            }
                            else {
                                expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                            }
                            expect(methodParameters).to.not.be.undefined;
                            let hasV3Pool = false;
                            let hasV2Pool = false;
                            for (const r of route) {
                                for (const pool of r) {
                                    if (pool.type == 'v3-pool') {
                                        hasV3Pool = true;
                                    }
                                    if (pool.type == 'v2-pool') {
                                        hasV2Pool = true;
                                    }
                                }
                            }
                            expect(hasV3Pool && hasV2Pool).to.be.true;
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(response.data.methodParameters, USDC_MAINNET, USDT_MAINNET);
                            if (type == 'exactIn') {
                                expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(USDT_MAINNET, quote));
                            }
                            else {
                                expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                                checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote));
                            }
                        });
                        /// Tests for routes likely to result in MixedRoutes being returned
                        if (type === 'exactIn') {
                            it(`erc20 -> erc20 forceMixedRoutes not specified for v2,v3 does not return mixed route even when it is better`, async () => {
                                const quoteReq = {
                                    tokenInAddress: 'BOND',
                                    tokenInChainId: 1,
                                    tokenOutAddress: 'APE',
                                    tokenOutChainId: 1,
                                    amount: await getAmount(1, type, 'BOND', 'APE', '10000'),
                                    type,
                                    recipient: alice.address,
                                    slippageTolerance: SLIPPAGE,
                                    deadline: '360',
                                    algorithm: 'alpha',
                                    protocols: 'v2,v3',
                                    enableUniversalRouter: true,
                                };
                                const queryParams = qs.stringify(quoteReq);
                                const response = await axios.get(`${API}?${queryParams}`);
                                const { data: { quoteDecimals, quoteGasAdjustedDecimals, methodParameters, routeString }, status, } = response;
                                expect(status).to.equal(200);
                                if (type == 'exactIn') {
                                    expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                                }
                                else {
                                    expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                                }
                                expect(methodParameters).to.not.be.undefined;
                                expect(!routeString.includes('[V2 + V3]'));
                            });
                            it(`erc20 -> erc20 forceMixedRoutes true for v2,v3`, async () => {
                                const quoteReq = {
                                    tokenInAddress: 'BOND',
                                    tokenInChainId: 1,
                                    tokenOutAddress: 'APE',
                                    tokenOutChainId: 1,
                                    amount: await getAmount(1, type, 'BOND', 'APE', '10000'),
                                    type,
                                    recipient: alice.address,
                                    slippageTolerance: SLIPPAGE,
                                    deadline: '360',
                                    algorithm: 'alpha',
                                    forceMixedRoutes: true,
                                    protocols: 'v2,v3',
                                    enableUniversalRouter: true,
                                };
                                await callAndExpectFail(quoteReq, {
                                    status: 404,
                                    data: {
                                        detail: 'No route found',
                                        errorCode: 'NO_ROUTE',
                                    },
                                });
                            });
                            it.skip(`erc20 -> erc20 forceMixedRoutes true for all protocols specified`, async () => {
                                const quoteReq = {
                                    tokenInAddress: 'BOND',
                                    tokenInChainId: 1,
                                    tokenOutAddress: 'APE',
                                    tokenOutChainId: 1,
                                    amount: await getAmount(1, type, 'BOND', 'APE', '10000'),
                                    type,
                                    recipient: alice.address,
                                    slippageTolerance: SLIPPAGE,
                                    deadline: '360',
                                    algorithm: 'alpha',
                                    forceMixedRoutes: true,
                                    protocols: 'v2,v3,mixed',
                                    enableUniversalRouter: true,
                                };
                                const queryParams = qs.stringify(quoteReq);
                                const response = await axios.get(`${API}?${queryParams}`);
                                const { data: { quoteDecimals, quoteGasAdjustedDecimals, methodParameters, routeString }, status, } = response;
                                expect(status).to.equal(200);
                                if (type == 'exactIn') {
                                    expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                                }
                                else {
                                    expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                                }
                                expect(methodParameters).to.not.be.undefined;
                                /// since we only get the routeString back, we can check if there's V3 + V2
                                expect(routeString.includes('[V2 + V3]'));
                            });
                        }
                        // FOT swap only works for exact in
                        if (type === 'exactIn') {
                            const tokenInAndTokenOut = [
                                [BULLET, WETH9[ChainId.MAINNET]],
                                [WETH9[ChainId.MAINNET], BULLET],
                            ];
                            tokenInAndTokenOut.forEach(([tokenIn, tokenOut]) => {
                                // If this test fails sporadically, dev needs to investigate further
                                // There could be genuine regressions in the form of race condition, due to complex layers of caching
                                // See https://github.com/Uniswap/smart-order-router/pull/415#issue-1914604864 as an example race condition
                                it(`fee-on-transfer ${tokenIn.symbol} -> ${tokenOut.symbol}`, async () => {
                                    var _a, _b, _c, _d, _e, _f, _g, _h;
                                    const enableFeeOnTransferFeeFetching = [true, false, undefined];
                                    // we want to swap the tokenIn/tokenOut order so that we can test both sellFeeBps and buyFeeBps for exactIn vs exactOut
                                    const originalAmount = tokenIn.equals(WETH9[ChainId.MAINNET]) ? '10' : '2924';
                                    const amount = await getAmountFromToken(type, tokenIn, tokenOut, originalAmount);
                                    // Parallelize the FOT quote requests, because we notice there might be tricky race condition that could cause quote to not include FOT tax
                                    const responses = await Promise.all(enableFeeOnTransferFeeFetching.map(async (enableFeeOnTransferFeeFetching) => {
                                        if (enableFeeOnTransferFeeFetching) {
                                            // if it's FOT flag enabled request, we delay it so that it's more likely to repro the race condition in
                                            // https://github.com/Uniswap/smart-order-router/pull/415#issue-1914604864
                                            await new Promise((f) => setTimeout(f, 1000));
                                        }
                                        const simulateFromAddress = tokenIn.equals(WETH9[ChainId.MAINNET])
                                            ? '0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3'
                                            : '0x171d311eAcd2206d21Cb462d661C33F0eddadC03';
                                        const quoteReq = {
                                            tokenInAddress: tokenIn.address,
                                            tokenInChainId: tokenIn.chainId,
                                            tokenOutAddress: tokenOut.address,
                                            tokenOutChainId: tokenOut.chainId,
                                            amount: amount,
                                            type: type,
                                            protocols: 'v2,v3,mixed',
                                            // TODO: ROUTE-86 remove enableFeeOnTransferFeeFetching once we are ready to enable this by default
                                            enableFeeOnTransferFeeFetching: enableFeeOnTransferFeeFetching,
                                            recipient: alice.address,
                                            // we have to use large slippage for FOT swap, because routing-api always forks at the latest block,
                                            // and the FOT swap can have large slippage, despite SOR already subtracted FOT tax
                                            slippageTolerance: LARGE_SLIPPAGE,
                                            deadline: '360',
                                            algorithm,
                                            enableUniversalRouter: true,
                                            // if fee-on-transfer flag is not enabled, most likely the simulation will fail due to quote not subtracting the tax
                                            simulateFromAddress: enableFeeOnTransferFeeFetching ? simulateFromAddress : undefined,
                                        };
                                        const queryParams = qs.stringify(quoteReq);
                                        const response = await axios.get(`${API}?${queryParams}`);
                                        return { enableFeeOnTransferFeeFetching, ...response };
                                    }));
                                    const quoteWithFlagOn = responses.find((r) => r.enableFeeOnTransferFeeFetching === true);
                                    expect(quoteWithFlagOn).not.to.be.undefined;
                                    responses
                                        .filter((r) => r.enableFeeOnTransferFeeFetching !== true)
                                        .forEach((r) => {
                                        var _a, _b;
                                        if (type === 'exactIn') {
                                            const quote = CurrencyAmount.fromRawAmount(tokenOut, r.data.quote);
                                            const quoteWithFlagon = CurrencyAmount.fromRawAmount(tokenOut, quoteWithFlagOn.data.quote);
                                            // quote without fot flag must be greater than the quote with fot flag
                                            // this is to catch https://github.com/Uniswap/smart-order-router/pull/421
                                            expect(quote.greaterThan(quoteWithFlagon)).to.be.true;
                                            // below is additional assertion to ensure the quote without fot tax vs quote with tax should be very roughly equal to the fot sell/buy tax rate
                                            const tokensDiff = quote.subtract(quoteWithFlagon);
                                            const percentDiff = tokensDiff.asFraction.divide(quote.asFraction);
                                            if (tokenIn === null || tokenIn === void 0 ? void 0 : tokenIn.equals(BULLET)) {
                                                expect(percentDiff.toFixed(3, undefined, Rounding.ROUND_HALF_UP)).equal(new Fraction(BigNumber.from((_a = BULLET_WHT_TAX.sellFeeBps) !== null && _a !== void 0 ? _a : 0).toString(), 10000).toFixed(3));
                                            }
                                            else if (tokenOut === null || tokenOut === void 0 ? void 0 : tokenOut.equals(BULLET)) {
                                                expect(percentDiff.toFixed(3, undefined, Rounding.ROUND_HALF_UP)).equal(new Fraction(BigNumber.from((_b = BULLET_WHT_TAX.buyFeeBps) !== null && _b !== void 0 ? _b : 0).toString(), 10000).toFixed(3));
                                            }
                                        }
                                    });
                                    for (const response of responses) {
                                        const { enableFeeOnTransferFeeFetching, data: { quote, quoteDecimals, quoteGasAdjustedDecimals, methodParameters, route, simulationStatus, simulationError, }, status, } = response;
                                        expect(status).to.equal(200);
                                        if (type == 'exactIn') {
                                            expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                                        }
                                        else {
                                            expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                                        }
                                        let hasV3Pool = false;
                                        let hasV2Pool = false;
                                        for (const r of route) {
                                            for (const pool of r) {
                                                if (pool.type == 'v3-pool') {
                                                    hasV3Pool = true;
                                                }
                                                if (pool.type == 'v2-pool') {
                                                    hasV2Pool = true;
                                                    if (enableFeeOnTransferFeeFetching) {
                                                        if (pool.tokenIn.address === BULLET.address) {
                                                            expect(pool.tokenIn.sellFeeBps).to.be.not.undefined;
                                                            expect(pool.tokenIn.sellFeeBps).to.be.equals((_a = BULLET_WHT_TAX.sellFeeBps) === null || _a === void 0 ? void 0 : _a.toString());
                                                            expect(pool.tokenIn.buyFeeBps).to.be.not.undefined;
                                                            expect(pool.tokenIn.buyFeeBps).to.be.equals((_b = BULLET_WHT_TAX.buyFeeBps) === null || _b === void 0 ? void 0 : _b.toString());
                                                        }
                                                        if (pool.tokenOut.address === BULLET.address) {
                                                            expect(pool.tokenOut.sellFeeBps).to.be.not.undefined;
                                                            expect(pool.tokenOut.sellFeeBps).to.be.equals((_c = BULLET_WHT_TAX.sellFeeBps) === null || _c === void 0 ? void 0 : _c.toString());
                                                            expect(pool.tokenOut.buyFeeBps).to.be.not.undefined;
                                                            expect(pool.tokenOut.buyFeeBps).to.be.equals((_d = BULLET_WHT_TAX.buyFeeBps) === null || _d === void 0 ? void 0 : _d.toString());
                                                        }
                                                        if (pool.reserve0.token.address === BULLET.address) {
                                                            expect(pool.reserve0.token.sellFeeBps).to.be.not.undefined;
                                                            expect(pool.reserve0.token.sellFeeBps).to.be.equals((_e = BULLET_WHT_TAX.sellFeeBps) === null || _e === void 0 ? void 0 : _e.toString());
                                                            expect(pool.reserve0.token.buyFeeBps).to.be.not.undefined;
                                                            expect(pool.reserve0.token.buyFeeBps).to.be.equals((_f = BULLET_WHT_TAX.buyFeeBps) === null || _f === void 0 ? void 0 : _f.toString());
                                                        }
                                                        if (pool.reserve1.token.address === BULLET.address) {
                                                            expect(pool.reserve1.token.sellFeeBps).to.be.not.undefined;
                                                            expect(pool.reserve1.token.sellFeeBps).to.be.equals((_g = BULLET_WHT_TAX.sellFeeBps) === null || _g === void 0 ? void 0 : _g.toString());
                                                            expect(pool.reserve1.token.buyFeeBps).to.be.not.undefined;
                                                            expect(pool.reserve1.token.buyFeeBps).to.be.equals((_h = BULLET_WHT_TAX.buyFeeBps) === null || _h === void 0 ? void 0 : _h.toString());
                                                        }
                                                    }
                                                    else {
                                                        expect(pool.tokenOut.sellFeeBps).to.be.undefined;
                                                        expect(pool.tokenOut.buyFeeBps).to.be.undefined;
                                                        expect(pool.reserve0.token.sellFeeBps).to.be.undefined;
                                                        expect(pool.reserve0.token.buyFeeBps).to.be.undefined;
                                                        expect(pool.reserve1.token.sellFeeBps).to.be.undefined;
                                                        expect(pool.reserve1.token.buyFeeBps).to.be.undefined;
                                                    }
                                                }
                                            }
                                        }
                                        expect(!hasV3Pool && hasV2Pool).to.be.true;
                                        if (enableFeeOnTransferFeeFetching) {
                                            expect(simulationStatus).to.equal('SUCCESS');
                                            expect(simulationError).to.equal(false);
                                            expect(methodParameters).to.not.be.undefined;
                                            // We don't have a bullet proof way to assert the fot-involved quote is post tax
                                            // so the best way is to execute the swap on hardhat mainnet fork,
                                            // and make sure the executed quote doesn't differ from callstatic simulated quote by over slippage tolerance
                                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(response.data.methodParameters, tokenIn, tokenOut);
                                            expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal(originalAmount);
                                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(tokenOut, quote));
                                        }
                                    }
                                });
                            });
                        }
                    }
                });
                if (algorithm == 'alpha') {
                    describe(`+ Simulate Swap + Execute Swap`, () => {
                        it(`erc20 -> erc20`, async () => {
                            const quoteReq = {
                                tokenInAddress: 'USDC',
                                tokenInChainId: 1,
                                tokenOutAddress: 'USDT',
                                tokenOutChainId: 1,
                                amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: SLIPPAGE,
                                deadline: '360',
                                algorithm,
                                simulateFromAddress: '0xf584f8728b874a6a5c7a8d4d387c9aae9172d621',
                                enableUniversalRouter: true,
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data: { quote, quoteDecimals, quoteGasAdjustedDecimals, methodParameters, simulationError }, status, } = response;
                            expect(status).to.equal(200);
                            expect(simulationError).to.equal(false);
                            expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                            expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                            if (type == 'exactIn') {
                                expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                            }
                            else {
                                expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                            }
                            expect(methodParameters).to.not.be.undefined;
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(methodParameters, USDC_MAINNET, USDT_MAINNET);
                            if (type == 'exactIn') {
                                expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(USDT_MAINNET, quote));
                            }
                            else {
                                expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                                checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote));
                            }
                        });
                        it(`erc20 -> erc20 swaprouter02`, async () => {
                            const quoteReq = {
                                tokenInAddress: 'USDC',
                                tokenInChainId: 1,
                                tokenOutAddress: 'USDT',
                                tokenOutChainId: 1,
                                amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: SLIPPAGE,
                                deadline: '360',
                                algorithm,
                                simulateFromAddress: '0xf584f8728b874a6a5c7a8d4d387c9aae9172d621',
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data: { quote, quoteDecimals, quoteGasAdjustedDecimals, methodParameters, simulationError }, status, } = response;
                            expect(status).to.equal(200);
                            expect(simulationError).to.equal(false);
                            expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                            expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                            if (type == 'exactIn') {
                                expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                            }
                            else {
                                expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                            }
                            expect(methodParameters).to.not.be.undefined;
                            expect(methodParameters.to).to.equal(SWAP_ROUTER_02_ADDRESSES(ChainId.MAINNET));
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(methodParameters, USDC_MAINNET, USDT_MAINNET);
                            if (type == 'exactIn') {
                                expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(USDT_MAINNET, quote));
                            }
                            else {
                                expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                                checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote));
                            }
                        });
                        if (isTesterPKEnvironmentSet()) {
                            it(`erc20 -> erc20 with permit with tester pk`, async () => {
                                // This test requires a private key with at least 10 USDC
                                // at FORK_BLOCK time.
                                const amount = await getAmount(1, type, 'USDC', 'USDT', '10');
                                const nonce = '0';
                                const permit = {
                                    details: {
                                        token: USDC_MAINNET.address,
                                        amount: amount,
                                        expiration: Math.floor(new Date().getTime() / 1000 + 10000000).toString(),
                                        nonce,
                                    },
                                    spender: UNIVERSAL_ROUTER_ADDRESS,
                                    sigDeadline: Math.floor(new Date().getTime() / 1000 + 10000000).toString(),
                                };
                                const wallet = new Wallet(process.env.TESTER_PK);
                                const { domain, types, values } = AllowanceTransfer.getPermitData(permit, PERMIT2_ADDRESS, 1);
                                const signature = await wallet._signTypedData(domain, types, values);
                                const quoteReq = {
                                    tokenInAddress: 'USDC',
                                    tokenInChainId: 1,
                                    tokenOutAddress: 'USDT',
                                    tokenOutChainId: 1,
                                    amount,
                                    type,
                                    recipient: wallet.address,
                                    slippageTolerance: SLIPPAGE,
                                    deadline: '360',
                                    algorithm,
                                    simulateFromAddress: wallet.address,
                                    permitSignature: signature,
                                    permitAmount: permit.details.amount.toString(),
                                    permitExpiration: permit.details.expiration.toString(),
                                    permitSigDeadline: permit.sigDeadline.toString(),
                                    permitNonce: permit.details.nonce.toString(),
                                    enableUniversalRouter: true,
                                };
                                const queryParams = qs.stringify(quoteReq);
                                const response = await axios.get(`${API}?${queryParams}`);
                                const { data: { quoteDecimals, quoteGasAdjustedDecimals, methodParameters, simulationError }, status, } = response;
                                expect(status).to.equal(200);
                                expect(simulationError).to.equal(false);
                                expect(parseFloat(quoteDecimals)).to.be.greaterThan(9);
                                expect(parseFloat(quoteDecimals)).to.be.lessThan(11);
                                if (type == 'exactIn') {
                                    expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                                }
                                else {
                                    expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                                }
                                expect(methodParameters).to.not.be.undefined;
                            });
                        }
                        it(`erc20 -> eth`, async () => {
                            const quoteReq = {
                                tokenInAddress: 'USDC',
                                tokenInChainId: 1,
                                tokenOutAddress: 'ETH',
                                tokenOutChainId: 1,
                                amount: await getAmount(1, type, 'USDC', 'ETH', type == 'exactIn' ? '1000000' : '10'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: SLIPPAGE,
                                deadline: '360',
                                algorithm,
                                simulateFromAddress: '0xf584f8728b874a6a5c7a8d4d387c9aae9172d621',
                                enableUniversalRouter: true,
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data: { quote, methodParameters, simulationError }, status, } = response;
                            expect(status).to.equal(200);
                            expect(simulationError).to.equal(false);
                            expect(methodParameters).to.not.be.undefined;
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(methodParameters, USDC_MAINNET, Ether.onChain(1));
                            if (type == 'exactIn') {
                                expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('1000000');
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(Ether.onChain(1), quote));
                            }
                            else {
                                // Hard to test ETH balance due to gas costs for approval and swap. Just check tokenIn changes
                                checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote));
                            }
                        });
                        it(`erc20 -> eth large trade`, async () => {
                            // Trade of this size almost always results in splits.
                            const quoteReq = {
                                tokenInAddress: 'USDC',
                                tokenInChainId: 1,
                                tokenOutAddress: 'ETH',
                                tokenOutChainId: 1,
                                amount: type == 'exactIn'
                                    ? await getAmount(1, type, 'USDC', 'ETH', '1000000')
                                    : await getAmount(1, type, 'USDC', 'ETH', '100'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: SLIPPAGE,
                                deadline: '360',
                                algorithm,
                                simulateFromAddress: '0xf584f8728b874a6a5c7a8d4d387c9aae9172d621',
                                enableUniversalRouter: true,
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data, status } = response;
                            expect(status).to.equal(200);
                            expect(data.simulationError).to.equal(false);
                            expect(data.methodParameters).to.not.be.undefined;
                            expect(data.route).to.not.be.undefined;
                            const amountInEdgesTotal = _(data.route)
                                .flatMap((route) => route[0])
                                .filter((pool) => !!pool.amountIn)
                                .map((pool) => BigNumber.from(pool.amountIn))
                                .reduce((cur, total) => total.add(cur), BigNumber.from(0));
                            const amountIn = BigNumber.from(data.quote);
                            expect(amountIn.eq(amountInEdgesTotal));
                            const amountOutEdgesTotal = _(data.route)
                                .flatMap((route) => route[0])
                                .filter((pool) => !!pool.amountOut)
                                .map((pool) => BigNumber.from(pool.amountOut))
                                .reduce((cur, total) => total.add(cur), BigNumber.from(0));
                            const amountOut = BigNumber.from(data.quote);
                            expect(amountOut.eq(amountOutEdgesTotal));
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, USDC_MAINNET, Ether.onChain(1));
                            if (type == 'exactIn') {
                                expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('1000000');
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(Ether.onChain(1), data.quote));
                            }
                            else {
                                // Hard to test ETH balance due to gas costs for approval and swap. Just check tokenIn changes
                                checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, data.quote));
                            }
                        });
                        it(`eth -> erc20`, async () => {
                            const quoteReq = {
                                tokenInAddress: 'ETH',
                                tokenInChainId: 1,
                                tokenOutAddress: 'UNI',
                                tokenOutChainId: 1,
                                amount: type == 'exactIn'
                                    ? await getAmount(1, type, 'ETH', 'UNI', '10')
                                    : await getAmount(1, type, 'ETH', 'UNI', '10000'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: type == 'exactOut' ? LARGE_SLIPPAGE : SLIPPAGE,
                                deadline: '360',
                                algorithm,
                                simulateFromAddress: '0x0716a17FBAeE714f1E6aB0f9d59edbC5f09815C0',
                                enableUniversalRouter: true,
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data, status } = response;
                            expect(status).to.equal(200);
                            expect(data.simulationError).to.equal(false);
                            expect(data.methodParameters).to.not.be.undefined;
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, Ether.onChain(1), UNI_MAINNET);
                            if (type == 'exactIn') {
                                // We've swapped 10 ETH + gas costs
                                expect(tokenInBefore.subtract(tokenInAfter).greaterThan(parseAmount('10', Ether.onChain(1)))).to.be.true;
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(UNI_MAINNET, data.quote));
                            }
                            else {
                                expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('10000');
                                // Can't easily check slippage for ETH due to gas costs effecting ETH balance.
                            }
                        });
                        it(`eth -> erc20 swaprouter02`, async () => {
                            const quoteReq = {
                                tokenInAddress: 'ETH',
                                tokenInChainId: 1,
                                tokenOutAddress: 'UNI',
                                tokenOutChainId: 1,
                                amount: type == 'exactIn'
                                    ? await getAmount(1, type, 'ETH', 'UNI', '10')
                                    : await getAmount(1, type, 'ETH', 'UNI', '10000'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: type == 'exactOut' ? LARGE_SLIPPAGE : SLIPPAGE,
                                deadline: '360',
                                algorithm,
                                simulateFromAddress: '0x00000000219ab540356cBB839Cbe05303d7705Fa',
                                enableUniversalRouter: false,
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data, status } = response;
                            expect(status).to.equal(200);
                            expect(data.methodParameters).to.not.be.undefined;
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, Ether.onChain(1), UNI_MAINNET);
                            if (type == 'exactIn') {
                                // We've swapped 10 ETH + gas costs
                                expect(tokenInBefore.subtract(tokenInAfter).greaterThan(parseAmount('10', Ether.onChain(1)))).to.be.true;
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(UNI_MAINNET, data.quote));
                                expect(data.simulationError).to.equal(false);
                            }
                            else {
                                expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('10000');
                                // Can't easily check slippage for ETH due to gas costs effecting ETH balance.
                            }
                        });
                        it(`weth -> erc20`, async () => {
                            const quoteReq = {
                                tokenInAddress: 'WETH',
                                tokenInChainId: 1,
                                tokenOutAddress: 'DAI',
                                tokenOutChainId: 1,
                                amount: await getAmount(1, type, 'WETH', 'DAI', '100'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: SLIPPAGE,
                                deadline: '360',
                                algorithm,
                                simulateFromAddress: '0xf04a5cc80b1e94c69b48f5ee68a08cd2f09a7c3e',
                                enableUniversalRouter: true,
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data, status } = response;
                            expect(status).to.equal(200);
                            expect(data.simulationError).to.equal(false);
                            expect(data.methodParameters).to.not.be.undefined;
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, WETH9[1], DAI_MAINNET);
                            if (type == 'exactIn') {
                                expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(DAI_MAINNET, data.quote));
                            }
                            else {
                                expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                                checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(WETH9[1], data.quote));
                            }
                        });
                        it(`erc20 -> weth`, async () => {
                            const quoteReq = {
                                tokenInAddress: 'USDC',
                                tokenInChainId: 1,
                                tokenOutAddress: 'WETH',
                                tokenOutChainId: 1,
                                amount: await getAmount(1, type, 'USDC', 'WETH', '100'),
                                type,
                                recipient: alice.address,
                                slippageTolerance: SLIPPAGE,
                                deadline: '360',
                                algorithm,
                                simulateFromAddress: '0xf584f8728b874a6a5c7a8d4d387c9aae9172d621',
                                enableUniversalRouter: true,
                            };
                            const queryParams = qs.stringify(quoteReq);
                            const response = await axios.get(`${API}?${queryParams}`);
                            const { data, status } = response;
                            expect(status).to.equal(200);
                            expect(data.simulationError).to.equal(false);
                            expect(data.methodParameters).to.not.be.undefined;
                            const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(data.methodParameters, USDC_MAINNET, WETH9[1]);
                            if (type == 'exactIn') {
                                expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal('100');
                                checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(WETH9[1], data.quote));
                            }
                            else {
                                expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal('100');
                                checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, data.quote));
                            }
                        });
                        const uraRefactorInterimState = ['before', 'after'];
                        GREENLIST_TOKEN_PAIRS.forEach(([tokenIn, tokenOut]) => {
                            uraRefactorInterimState.forEach((state) => {
                                it(`${tokenIn.symbol} -> ${tokenOut.symbol} with portion, state = ${state}`, async () => {
                                    const originalAmount = '10';
                                    const tokenInSymbol = tokenIn.symbol;
                                    const tokenOutSymbol = tokenOut.symbol;
                                    const tokenInAddress = tokenIn.isNative ? tokenInSymbol : tokenIn.address;
                                    const tokenOutAddress = tokenOut.isNative ? tokenOutSymbol : tokenOut.address;
                                    const amount = await getAmountFromToken(type, tokenIn.wrapped, tokenOut.wrapped, originalAmount);
                                    // we need to simulate URA before and after merging https://github.com/Uniswap/unified-routing-api/pull/282 interim states
                                    // to ensure routing-api is backward compatible with URA
                                    let portionBips = undefined;
                                    if (state === 'before' && type === 'exactIn') {
                                        portionBips = FLAT_PORTION.bips;
                                    }
                                    else if (state === 'after') {
                                        portionBips = FLAT_PORTION.bips;
                                    }
                                    let portionAmount = undefined;
                                    if (state === 'before' && type === 'exactOut') {
                                        portionAmount = CurrencyAmount.fromRawAmount(tokenOut, amount)
                                            .multiply(new Fraction(FLAT_PORTION.bips, 10000))
                                            .quotient.toString();
                                    }
                                    else if (state === 'after') {
                                        // after URA merges https://github.com/Uniswap/unified-routing-api/pull/282,
                                        // it no longer sends portionAmount
                                        portionAmount = undefined;
                                    }
                                    const quoteReq = {
                                        tokenInAddress: tokenInAddress,
                                        tokenInChainId: tokenIn.chainId,
                                        tokenOutAddress: tokenOutAddress,
                                        tokenOutChainId: tokenOut.chainId,
                                        amount: amount,
                                        type: type,
                                        protocols: 'v2,v3,mixed',
                                        recipient: alice.address,
                                        slippageTolerance: SLIPPAGE,
                                        deadline: '360',
                                        algorithm,
                                        enableUniversalRouter: true,
                                        simulateFromAddress: alice.address,
                                        portionBips: portionBips,
                                        portionAmount: portionAmount,
                                        portionRecipient: FLAT_PORTION.recipient,
                                    };
                                    const queryParams = qs.stringify(quoteReq);
                                    const response = await axios.get(`${API}?${queryParams}`);
                                    const { data, status } = response;
                                    expect(status).to.equal(200);
                                    expect(data.simulationError).to.equal(false);
                                    expect(data.methodParameters).to.not.be.undefined;
                                    expect(data.portionRecipient).to.not.be.undefined;
                                    if (!(state === 'before' && type === 'exactOut')) {
                                        // before URA interim state it doesnt send portionBips to routing-api,
                                        // so routing-api has no way to know the portionBips
                                        expect(data.portionBips).to.not.be.undefined;
                                        expect(data.portionBips).to.equal(FLAT_PORTION.bips);
                                    }
                                    expect(data.portionAmount).to.not.be.undefined;
                                    expect(data.portionAmountDecimals).to.not.be.undefined;
                                    expect(data.quoteGasAndPortionAdjusted).to.not.be.undefined;
                                    expect(data.quoteGasAndPortionAdjustedDecimals).to.not.be.undefined;
                                    expect(data.portionRecipient).to.equal(FLAT_PORTION.recipient);
                                    if (type == 'exactIn') {
                                        const allQuotesAcrossRoutes = data.route
                                            .map((routes) => routes
                                            .map((route) => route.amountOut)
                                            .map((amountOut) => CurrencyAmount.fromRawAmount(tokenOut, amountOut !== null && amountOut !== void 0 ? amountOut : '0'))
                                            .reduce((cur, total) => total.add(cur), CurrencyAmount.fromRawAmount(tokenOut, '0')))
                                            .reduce((cur, total) => total.add(cur), CurrencyAmount.fromRawAmount(tokenOut, '0'));
                                        const quote = CurrencyAmount.fromRawAmount(tokenOut, data.quote);
                                        const expectedPortionAmount = quote.multiply(new Fraction(FLAT_PORTION.bips, 10000));
                                        expect(data.portionAmount).to.equal(expectedPortionAmount.quotient.toString());
                                        // The most strict way to ensure the output amount from route path is correct with respect to portion
                                        // is to make sure the output amount from route path is exactly portion bps different from the quote
                                        const tokensDiff = quote.subtract(allQuotesAcrossRoutes);
                                        const percentDiff = tokensDiff.asFraction.divide(quote.asFraction);
                                        expect(percentDiff.quotient.toString()).equal(new Fraction(FLAT_PORTION.bips, 10000).quotient.toString());
                                    }
                                    else {
                                        const allQuotesAcrossRoutes = data.route
                                            .map((routes) => routes
                                            .map((route) => route.amountOut)
                                            .map((amountOut) => CurrencyAmount.fromRawAmount(tokenIn, amountOut !== null && amountOut !== void 0 ? amountOut : '0'))
                                            .reduce((cur, total) => total.add(cur), CurrencyAmount.fromRawAmount(tokenIn, '0')))
                                            .reduce((cur, total) => total.add(cur), CurrencyAmount.fromRawAmount(tokenIn, '0'));
                                        const quote = CurrencyAmount.fromRawAmount(tokenIn, data.quote);
                                        const expectedPortionAmount = CurrencyAmount.fromRawAmount(tokenOut, amount).multiply(new Fraction(FLAT_PORTION.bips, 10000));
                                        expect(data.portionAmount).to.equal(expectedPortionAmount.quotient.toString());
                                        // The most strict way to ensure the output amount from route path is correct with respect to portion
                                        // is to make sure the output amount from route path is exactly portion bps different from the quote
                                        const tokensDiff = allQuotesAcrossRoutes.subtract(quote);
                                        const percentDiff = tokensDiff.asFraction.divide(quote.asFraction);
                                        expect(percentDiff.quotient.toString()).equal(new Fraction(FLAT_PORTION.bips, 10000).quotient.toString());
                                    }
                                    const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter, tokenOutPortionRecipientBefore, tokenOutPortionRecipientAfter, } = await executeSwap(data.methodParameters, tokenIn, tokenOut, false, tokenIn.chainId, FLAT_PORTION);
                                    if (type == 'exactIn') {
                                        // if the token in is native token, the difference will be slightly larger due to gas. We have no way to know precise gas costs in terms of GWEI * gas units.
                                        if (!tokenIn.isNative) {
                                            expect(tokenInBefore.subtract(tokenInAfter).toExact()).to.equal(originalAmount);
                                        }
                                        // if the token out is native token, the difference will be slightly larger due to gas. We have no way to know precise gas costs in terms of GWEI * gas units.
                                        if (!tokenOut.isNative) {
                                            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(tokenOut, data.quote));
                                        }
                                        expect(data.portionAmount).not.to.be.undefined;
                                        const expectedPortionAmount = CurrencyAmount.fromRawAmount(tokenOut, data.portionAmount);
                                        checkPortionRecipientToken(tokenOutPortionRecipientBefore, tokenOutPortionRecipientAfter, expectedPortionAmount);
                                    }
                                    else {
                                        // if the token out is native token, the difference will be slightly larger due to gas. We have no way to know precise gas costs in terms of GWEI * gas units.
                                        if (!tokenOut.isNative) {
                                            expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).to.equal(originalAmount);
                                        }
                                        // if the token out is native token, the difference will be slightly larger due to gas. We have no way to know precise gas costs in terms of GWEI * gas units.
                                        if (!tokenIn.isNative) {
                                            checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(tokenIn, data.quote));
                                        }
                                        expect(data.portionAmount).not.to.be.undefined;
                                        const expectedPortionAmount = CurrencyAmount.fromRawAmount(tokenOut, data.portionAmount);
                                        checkPortionRecipientToken(tokenOutPortionRecipientBefore, tokenOutPortionRecipientAfter, expectedPortionAmount);
                                    }
                                });
                            });
                        });
                    });
                }
                it(`erc20 -> erc20 no recipient/deadline/slippage`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDC',
                        tokenInChainId: 1,
                        tokenOutAddress: 'USDT',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                        type,
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    const queryParams = qs.stringify(quoteReq);
                    const response = await axios.get(`${API}?${queryParams}`);
                    const { data: { quoteDecimals, quoteGasAdjustedDecimals, methodParameters }, status, } = response;
                    expect(status).to.equal(200);
                    expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                    expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                    if (type == 'exactIn') {
                        expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                    }
                    else {
                        expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                    }
                    expect(methodParameters).to.be.undefined;
                });
                it(`one of recipient/deadline/slippage is missing`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDC',
                        tokenInChainId: 1,
                        tokenOutAddress: 'USDT',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                        type,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    const queryParams = qs.stringify(quoteReq);
                    const response = await axios.get(`${API}?${queryParams}`);
                    const { data: { quoteDecimals, quoteGasAdjustedDecimals, methodParameters }, status, } = response;
                    expect(status).to.equal(200);
                    expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                    expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                    if (type == 'exactIn') {
                        expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                    }
                    else {
                        expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                    }
                    // Since ur-sdk hardcodes recipient in case of no recipient https://github.com/Uniswap/universal-router-sdk/blob/main/src/entities/protocols/uniswap.ts#L68
                    // the calldata will still get generated even if URA doesn't pass in recipient
                    expect(methodParameters).not.to.be.undefined;
                });
                it(`erc20 -> erc20 gas price specified`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDC',
                        tokenInChainId: 1,
                        tokenOutAddress: 'USDT',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                        type,
                        algorithm,
                        gasPriceWei: '60000000000',
                        enableUniversalRouter: true,
                    };
                    const queryParams = qs.stringify(quoteReq);
                    const response = await axios.get(`${API}?${queryParams}`);
                    const { data: { quoteDecimals, quoteGasAdjustedDecimals, methodParameters, gasPriceWei }, status, } = response;
                    expect(status).to.equal(200);
                    if (algorithm == 'alpha') {
                        expect(gasPriceWei).to.equal('60000000000');
                    }
                    expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                    expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                    if (type == 'exactIn') {
                        expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                    }
                    else {
                        expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                    }
                    expect(methodParameters).to.be.undefined;
                });
                it(`erc20 -> erc20 by address`, async () => {
                    const quoteReq = {
                        tokenInAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
                        tokenInChainId: 1,
                        tokenOutAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'DAI', 'USDC', '100'),
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    const queryParams = qs.stringify(quoteReq);
                    const response = await axios.get(`${API}?${queryParams}`);
                    const { data: { quoteDecimals, quoteGasAdjustedDecimals }, status, } = response;
                    expect(status).to.equal(200);
                    expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                    if (type == 'exactIn') {
                        expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                    }
                    else {
                        expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                    }
                    expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                });
                it(`erc20 -> erc20 one by address one by symbol`, async () => {
                    const quoteReq = {
                        tokenInAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
                        tokenInChainId: 1,
                        tokenOutAddress: 'USDC',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'DAI', 'USDC', '100'),
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    const queryParams = qs.stringify(quoteReq);
                    const response = await axios.get(`${API}?${queryParams}`);
                    const { data: { quoteDecimals, quoteGasAdjustedDecimals }, status, } = response;
                    expect(status).to.equal(200);
                    expect(parseFloat(quoteDecimals)).to.be.greaterThan(90);
                    if (type == 'exactIn') {
                        expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                    }
                    else {
                        expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                    }
                    expect(parseFloat(quoteDecimals)).to.be.lessThan(110);
                });
            });
            describe(`${ID_TO_NETWORK_NAME(1)} ${algorithm} ${type} 4xx`, () => {
                it(`field is missing in body`, async () => {
                    const quoteReq = {
                        tokenOutAddress: 'USDT',
                        tokenInChainId: 1,
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: '"tokenInAddress" is required',
                            errorCode: 'VALIDATION_ERROR',
                        },
                    });
                });
                it.skip(`amount is too big to find route`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'UNI',
                        tokenInChainId: 1,
                        tokenOutAddress: 'KNC',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'UNI', 'KNC', '9999999999999999999999999999999999999999999999999'),
                        type,
                        recipient: '0x88fc765949a27405480F374Aa49E20dcCD3fCfb8',
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: 'No route found',
                            errorCode: 'NO_ROUTE',
                        },
                    });
                });
                it(`amount is too big for uint256`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDC',
                        tokenInChainId: 1,
                        tokenOutAddress: 'USDT',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'USDC', 'USDT', '100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'),
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                    };
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: '"amount" length must be less than or equal to 77 characters long',
                            errorCode: 'VALIDATION_ERROR',
                        },
                    });
                });
                it(`amount is negative`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDC',
                        tokenInChainId: 1,
                        tokenOutAddress: 'USDT',
                        tokenOutChainId: 1,
                        amount: '-10000000000',
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: '"amount" with value "-10000000000" fails to match the required pattern: /^[0-9]+$/',
                            errorCode: 'VALIDATION_ERROR',
                        },
                    });
                });
                it(`amount is decimal`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDC',
                        tokenInChainId: 1,
                        tokenOutAddress: 'USDT',
                        tokenOutChainId: 1,
                        amount: '1000000000.25',
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: '"amount" with value "1000000000.25" fails to match the required pattern: /^[0-9]+$/',
                            errorCode: 'VALIDATION_ERROR',
                        },
                    });
                });
                it(`symbol doesnt exist`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDC',
                        tokenInChainId: 1,
                        tokenOutAddress: 'NONEXISTANTTOKEN',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                    };
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: 'Could not find token with address "NONEXISTANTTOKEN"',
                            errorCode: 'TOKEN_OUT_INVALID',
                        },
                    });
                });
                it(`tokens are the same symbol`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDT',
                        tokenInChainId: 1,
                        tokenOutAddress: 'USDT',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'USDC', 'USDT', '100'),
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: 'tokenIn and tokenOut must be different',
                            errorCode: 'TOKEN_IN_OUT_SAME',
                        },
                    });
                });
                it(`tokens are the same symbol and address`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDT',
                        tokenInChainId: 1,
                        tokenOutAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'USDT', 'USDT', '100'),
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: 'tokenIn and tokenOut must be different',
                            errorCode: 'TOKEN_IN_OUT_SAME',
                        },
                    });
                });
                it(`tokens are the same address`, async () => {
                    const quoteReq = {
                        tokenInAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
                        tokenInChainId: 1,
                        tokenOutAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'USDT', 'USDT', '100'),
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: 'tokenIn and tokenOut must be different',
                            errorCode: 'TOKEN_IN_OUT_SAME',
                        },
                    });
                });
                it(`recipient is an invalid address`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDT',
                        tokenInChainId: 1,
                        tokenOutAddress: 'USDC',
                        tokenOutChainId: 1,
                        amount: await getAmount(1, type, 'USDT', 'USDC', '100'),
                        type,
                        recipient: '0xAb5801a7D398351b8bE11C439e05C5B3259aZZZZZZZ',
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: '"recipient" with value "0xAb5801a7D398351b8bE11C439e05C5B3259aZZZZZZZ" fails to match the required pattern: /^0x[a-fA-F0-9]{40}$/',
                            errorCode: 'VALIDATION_ERROR',
                        },
                    });
                });
                it(`unsupported chain`, async () => {
                    const quoteReq = {
                        tokenInAddress: 'USDC',
                        tokenInChainId: 70,
                        tokenOutAddress: 'USDT',
                        tokenOutChainId: 70,
                        amount: '10000000000',
                        type,
                        recipient: alice.address,
                        slippageTolerance: SLIPPAGE,
                        deadline: '360',
                        algorithm,
                        enableUniversalRouter: true,
                    };
                    const chains = SUPPORTED_CHAINS.values();
                    const chainStr = [...chains].toString().split(',').join(', ');
                    await callAndExpectFail(quoteReq, {
                        status: 400,
                        data: {
                            detail: `"tokenInChainId" must be one of [${chainStr}]`,
                            errorCode: 'VALIDATION_ERROR',
                        },
                    });
                });
            });
        }
    }
    const TEST_ERC20_1 = {
        [ChainId.MAINNET]: () => USDC_ON(1),
        [ChainId.GOERLI]: () => USDC_ON(ChainId.GOERLI),
        [ChainId.SEPOLIA]: () => USDC_ON(ChainId.SEPOLIA),
        [ChainId.OPTIMISM]: () => USDC_ON(ChainId.OPTIMISM),
        [ChainId.OPTIMISM_GOERLI]: () => USDC_ON(ChainId.OPTIMISM_GOERLI),
        [ChainId.ARBITRUM_ONE]: () => USDC_ON(ChainId.ARBITRUM_ONE),
        [ChainId.POLYGON]: () => USDC_ON(ChainId.POLYGON),
        [ChainId.POLYGON_MUMBAI]: () => USDC_ON(ChainId.POLYGON_MUMBAI),
        [ChainId.CELO]: () => CUSD_CELO,
        [ChainId.CELO_ALFAJORES]: () => CUSD_CELO_ALFAJORES,
        [ChainId.MOONBEAM]: () => null,
        [ChainId.GNOSIS]: () => null,
        [ChainId.ARBITRUM_GOERLI]: () => null,
        [ChainId.BNB]: () => USDC_ON(ChainId.BNB),
        [ChainId.BNB_TESTNET]: () => null,
        [ChainId.AVALANCHE]: () => USDC_ON(ChainId.AVALANCHE),
        [ChainId.BASE_GOERLI]: () => USDC_ON(ChainId.BASE_GOERLI),
        [ChainId.BASE]: () => USDC_ON(ChainId.BASE),
    };
    const TEST_ERC20_2 = {
        [ChainId.MAINNET]: () => DAI_ON(1),
        [ChainId.GOERLI]: () => DAI_ON(ChainId.GOERLI),
        [ChainId.SEPOLIA]: () => DAI_ON(ChainId.SEPOLIA),
        [ChainId.OPTIMISM]: () => DAI_ON(ChainId.OPTIMISM),
        [ChainId.OPTIMISM_GOERLI]: () => DAI_ON(ChainId.OPTIMISM_GOERLI),
        [ChainId.ARBITRUM_ONE]: () => DAI_ON(ChainId.ARBITRUM_ONE),
        [ChainId.POLYGON]: () => DAI_ON(ChainId.POLYGON),
        [ChainId.POLYGON_MUMBAI]: () => DAI_ON(ChainId.POLYGON_MUMBAI),
        [ChainId.CELO]: () => CEUR_CELO,
        [ChainId.CELO_ALFAJORES]: () => CEUR_CELO_ALFAJORES,
        [ChainId.MOONBEAM]: () => null,
        [ChainId.GNOSIS]: () => null,
        [ChainId.ARBITRUM_GOERLI]: () => null,
        [ChainId.BNB]: () => USDT_ON(ChainId.BNB),
        [ChainId.BNB_TESTNET]: () => null,
        [ChainId.AVALANCHE]: () => DAI_ON(ChainId.AVALANCHE),
        [ChainId.BASE_GOERLI]: () => WNATIVE_ON(ChainId.BASE_GOERLI),
        [ChainId.BASE]: () => WNATIVE_ON(ChainId.BASE),
    };
    // TODO: Find valid pools/tokens on optimistic kovan and polygon mumbai. We skip those tests for now.
    for (const chain of _.filter(SUPPORTED_CHAINS, (c) => c != ChainId.POLYGON_MUMBAI &&
        c != ChainId.ARBITRUM_GOERLI &&
        c != ChainId.CELO_ALFAJORES &&
        c != ChainId.GOERLI &&
        c != ChainId.SEPOLIA)) {
        for (const type of ['exactIn', 'exactOut']) {
            const erc1 = TEST_ERC20_1[chain]();
            const erc2 = TEST_ERC20_2[chain]();
            // This is for Gnosis and Moonbeam which we don't have RPC Providers yet
            if (erc1 == null || erc2 == null)
                continue;
            describe(`${ID_TO_NETWORK_NAME(chain)} ${type} 2xx`, function () {
                // Help with test flakiness by retrying.
                this.retries(0);
                const wrappedNative = WNATIVE_ON(chain);
                it(`${wrappedNative.symbol} -> erc20`, async () => {
                    const quoteReq = {
                        tokenInAddress: wrappedNative.address,
                        tokenInChainId: chain,
                        tokenOutAddress: erc1.address,
                        tokenOutChainId: chain,
                        amount: await getAmountFromToken(type, wrappedNative, erc1, '1'),
                        type,
                        enableUniversalRouter: true,
                    };
                    const queryParams = qs.stringify(quoteReq);
                    try {
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { status } = response;
                        expect(status).to.equal(200);
                    }
                    catch (err) {
                        fail(JSON.stringify(err.response.data));
                    }
                });
                it(`erc20 -> erc20`, async () => {
                    const quoteReq = {
                        tokenInAddress: erc1.address,
                        tokenInChainId: chain,
                        tokenOutAddress: erc2.address,
                        tokenOutChainId: chain,
                        amount: await getAmountFromToken(type, erc1, erc2, '1'),
                        type,
                    };
                    const queryParams = qs.stringify(quoteReq);
                    try {
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { status } = response;
                        expect(status).to.equal(200);
                    }
                    catch (err) {
                        fail(JSON.stringify(err.response.data));
                    }
                });
                const native = NATIVE_CURRENCY[chain];
                it(`${native} -> erc20`, async () => {
                    // TODO ROUTE-64: Remove this once smart-order-router supports ETH native currency on BASE
                    // see https://uniswapteam.slack.com/archives/C021SU4PMR7/p1691593679108459?thread_ts=1691532336.742419&cid=C021SU4PMR7
                    const baseErc20 = chain == ChainId.BASE ? USDC_ON(ChainId.BASE) : erc2;
                    const quoteReq = {
                        tokenInAddress: native,
                        tokenInChainId: chain,
                        tokenOutAddress: baseErc20.address,
                        tokenOutChainId: chain,
                        amount: await getAmountFromToken(type, WNATIVE_ON(chain), baseErc20, '1'),
                        type,
                        enableUniversalRouter: true,
                    };
                    const queryParams = qs.stringify(quoteReq);
                    try {
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { status } = response;
                        expect(status).to.equal(200, JSON.stringify(response.data));
                    }
                    catch (err) {
                        fail(JSON.stringify(err.response.data));
                    }
                });
                it(`has quoteGasAdjusted values`, async () => {
                    const quoteReq = {
                        tokenInAddress: erc1.address,
                        tokenInChainId: chain,
                        tokenOutAddress: erc2.address,
                        tokenOutChainId: chain,
                        amount: await getAmountFromToken(type, erc1, erc2, '1'),
                        type,
                    };
                    const queryParams = qs.stringify(quoteReq);
                    try {
                        const response = await axios.get(`${API}?${queryParams}`);
                        const { data: { quoteDecimals, quoteGasAdjustedDecimals }, status, } = response;
                        expect(status).to.equal(200);
                        // check for quotes to be gas adjusted
                        if (type == 'exactIn') {
                            expect(parseFloat(quoteGasAdjustedDecimals)).to.be.lessThanOrEqual(parseFloat(quoteDecimals));
                        }
                        else {
                            expect(parseFloat(quoteGasAdjustedDecimals)).to.be.greaterThanOrEqual(parseFloat(quoteDecimals));
                        }
                    }
                    catch (err) {
                        fail(JSON.stringify(err.response.data));
                    }
                });
            });
        }
    }
});
describe('alpha only quote', function () {
    this.timeout(5000);
    for (const type of ['exactIn', 'exactOut']) {
        describe(`${type} 2xx`, () => { });
    }
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicXVvdGUudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3Rlc3QvbW9jaGEvaW50ZWcvcXVvdGUudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEVBQUUsaUJBQWlCLEVBQWdCLE1BQU0sc0JBQXNCLENBQUE7QUFDdEUsT0FBTyxFQUFFLE9BQU8sRUFBWSxjQUFjLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxNQUFNLG1CQUFtQixDQUFBO0FBQzlHLE9BQU8sRUFDTCxTQUFTLEVBQ1QsbUJBQW1CLEVBQ25CLFNBQVMsRUFDVCxtQkFBbUIsRUFDbkIsV0FBVyxFQUNYLGtCQUFrQixFQUNsQixlQUFlLEVBQ2YsV0FBVyxFQUNYLHdCQUF3QixFQUN4QixZQUFZLEVBQ1osWUFBWSxFQUNaLFlBQVksR0FDYixNQUFNLDZCQUE2QixDQUFBO0FBQ3BDLE9BQU8sRUFDTCxlQUFlLEVBQ2Ysd0JBQXdCLElBQUksaUNBQWlDLEdBQzlELE1BQU0sK0JBQStCLENBQUE7QUFFdEMsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFFBQVEsQ0FBQTtBQUM3QixPQUFPLFdBQThCLE1BQU0sT0FBTyxDQUFBO0FBQ2xELE9BQU8sVUFBVSxNQUFNLGFBQWEsQ0FBQTtBQUNwQyxPQUFPLElBQUksRUFBRSxFQUFFLE1BQU0sRUFBRSxNQUFNLE1BQU0sQ0FBQTtBQUNuQyxPQUFPLGNBQWMsTUFBTSxrQkFBa0IsQ0FBQTtBQUM3QyxPQUFPLFVBQVUsTUFBTSxhQUFhLENBQUE7QUFDcEMsT0FBTyxFQUFFLFNBQVMsRUFBYSxNQUFNLEVBQUUsTUFBTSxRQUFRLENBQUE7QUFDckQsT0FBTyxHQUFHLE1BQU0sU0FBUyxDQUFBO0FBQ3pCLE9BQU8sQ0FBQyxNQUFNLFFBQVEsQ0FBQTtBQUN0QixPQUFPLEVBQUUsTUFBTSxJQUFJLENBQUE7QUFDbkIsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sb0NBQW9DLENBQUE7QUFHckUsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sd0JBQXdCLENBQUE7QUFDekQsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0seUJBQXlCLENBQUE7QUFDN0QsT0FBTyxFQUFFLFVBQVUsRUFBRSxvQkFBb0IsRUFBRSxNQUFNLGtDQUFrQyxDQUFBO0FBQ25GLE9BQU8sRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFFLGtCQUFrQixFQUFFLFdBQVcsRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLG9CQUFvQixDQUFBO0FBQ3JILE9BQU8sRUFBRSxZQUFZLEVBQUUscUJBQXFCLEVBQVcsTUFBTSw4QkFBOEIsQ0FBQTtBQUUzRixNQUFNLEVBQUUsTUFBTSxFQUFFLEdBQUcsR0FBRyxDQUFBO0FBRXRCLElBQUksQ0FBQyxHQUFHLENBQUMsY0FBYyxDQUFDLENBQUE7QUFDeEIsSUFBSSxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQTtBQUVwQixNQUFNLHdCQUF3QixHQUFHLGlDQUFpQyxDQUFDLENBQUMsQ0FBQyxDQUFBO0FBRXJFLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLG1CQUFtQixJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsRUFBRTtJQUNyRSxNQUFNLElBQUksS0FBSyxDQUFDLDZGQUE2RixDQUFDLENBQUE7Q0FDL0c7QUFFRCxNQUFNLEdBQUcsR0FBRyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW9CLE9BQU8sQ0FBQTtBQUV0RCxNQUFNLFFBQVEsR0FBRyxHQUFHLENBQUE7QUFDcEIsTUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFBO0FBRTNCLE1BQU0sTUFBTSxHQUFHLElBQUksS0FBSyxDQUN0QixPQUFPLENBQUMsT0FBTyxFQUNmLDRDQUE0QyxFQUM1QyxDQUFDLEVBQ0QsUUFBUSxFQUNSLDJCQUEyQixDQUM1QixDQUFBO0FBQ0QsTUFBTSxjQUFjLEdBQUcsSUFBSSxLQUFLLENBQzlCLE9BQU8sQ0FBQyxPQUFPLEVBQ2YsNENBQTRDLEVBQzVDLENBQUMsRUFDRCxRQUFRLEVBQ1IsMkJBQTJCLEVBQzNCLEtBQUssRUFDTCxTQUFTLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUNuQixTQUFTLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUNwQixDQUFBO0FBRUQsTUFBTSxLQUFLLEdBQUcsV0FBVyxDQUFDLE1BQU0sRUFBRSxDQUFBO0FBQ2xDLFVBQVUsQ0FBQyxLQUFLLEVBQUU7SUFDaEIsT0FBTyxFQUFFLEVBQUU7SUFDWCxjQUFjLEVBQUUsQ0FBQyxHQUFHLEVBQUUsRUFBRSxXQUFDLE9BQUEsQ0FBQSxNQUFBLEdBQUcsQ0FBQyxRQUFRLDBDQUFFLE1BQU0sS0FBSSxHQUFHLENBQUEsRUFBQTtJQUNwRCxVQUFVLEVBQUUsVUFBVSxDQUFDLGdCQUFnQjtDQUN4QyxDQUFDLENBQUE7QUFFRixNQUFNLGlCQUFpQixHQUFHLEtBQUssRUFBRSxRQUFtQyxFQUFFLElBQW1DLEVBQUUsRUFBRTtJQUMzRyxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO0lBQzFDLElBQUk7UUFDRixNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7UUFDdkQsSUFBSSxFQUFFLENBQUE7S0FDUDtJQUFDLE9BQU8sR0FBUSxFQUFFO1FBQ2pCLE1BQU0sQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsQ0FBQTtLQUM1QztBQUNILENBQUMsQ0FBQTtBQUVELE1BQU0sZUFBZSxHQUFHLENBQ3RCLE1BQWdDLEVBQ2hDLEtBQStCLEVBQy9CLFlBQXNDLEVBQ3RDLEVBQUU7SUFDRix3REFBd0Q7SUFDeEQsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQTtJQUVqRyxNQUFNLFVBQVUsR0FBRyxZQUFZLENBQUMsV0FBVyxDQUFDLGFBQWEsQ0FBQztRQUN4RCxDQUFDLENBQUMsWUFBWSxDQUFDLFFBQVEsQ0FBQyxhQUFhLENBQUM7UUFDdEMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUE7SUFDeEMsTUFBTSxXQUFXLEdBQUcsVUFBVSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLFVBQVUsQ0FBQyxDQUFBO0lBQ3pFLE1BQU0sQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLElBQUksUUFBUSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUE7QUFDaEYsQ0FBQyxDQUFBO0FBRUQsTUFBTSwwQkFBMEIsR0FBRyxDQUNqQyxNQUFnQyxFQUNoQyxLQUErQixFQUMvQiw2QkFBdUQsRUFDdkQsRUFBRTtJQUNGLE1BQU0sMkJBQTJCLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQTtJQUUxRCxNQUFNLFVBQVUsR0FBRyw2QkFBNkIsQ0FBQyxXQUFXLENBQUMsMkJBQTJCLENBQUM7UUFDdkYsQ0FBQyxDQUFDLDZCQUE2QixDQUFDLFFBQVEsQ0FBQywyQkFBMkIsQ0FBQztRQUNyRSxDQUFDLENBQUMsMkJBQTJCLENBQUMsUUFBUSxDQUFDLDZCQUE2QixDQUFDLENBQUE7SUFDdkUsOEdBQThHO0lBQzlHLE1BQU0sV0FBVyxHQUFHLFVBQVUsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLDZCQUE2QixDQUFDLFVBQVUsQ0FBQyxDQUFBO0lBQzFGLE1BQU0sQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLElBQUksUUFBUSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUE7QUFDaEYsQ0FBQyxDQUFBO0FBRUQsSUFBSSxjQUFjLEdBQUcsS0FBSyxDQUFBO0FBQzFCLE1BQU0sd0JBQXdCLEdBQUcsR0FBWSxFQUFFO0lBQzdDLE1BQU0sS0FBSyxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQTtJQUNyQyxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsY0FBYyxFQUFFO1FBQzdCLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0ZBQWdGLENBQUMsQ0FBQTtRQUM3RixjQUFjLEdBQUcsSUFBSSxDQUFBO0tBQ3RCO0lBQ0QsT0FBTyxLQUFLLENBQUE7QUFDZCxDQUFDLENBQUE7QUFFRCxNQUFNLFdBQVcsR0FBRyw0Q0FBNEMsQ0FBQTtBQUVoRSxRQUFRLENBQUMsT0FBTyxFQUFFO0lBQ2hCLHdDQUF3QztJQUN4QyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFBO0lBRWYsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQTtJQUVwQixJQUFJLEtBQXdCLENBQUE7SUFDNUIsSUFBSSxLQUFhLENBQUE7SUFDakIsSUFBSSxRQUFRLEdBQVcsQ0FBQyxDQUFBO0lBQ3hCLElBQUksZUFBZSxHQUFpQixHQUFHLEVBQUU7UUFDdkMsTUFBTSxLQUFLLEdBQUcsUUFBUSxDQUFDLFFBQVEsRUFBRSxDQUFBO1FBQ2pDLFFBQVEsR0FBRyxRQUFRLEdBQUcsQ0FBQyxDQUFBO1FBQ3ZCLE9BQU8sS0FBSyxDQUFBO0lBQ2QsQ0FBQyxDQUFBO0lBRUQsTUFBTSxXQUFXLEdBQUcsS0FBSyxFQUN2QixnQkFBa0MsRUFDbEMsVUFBb0IsRUFDcEIsV0FBcUIsRUFDckIsTUFBZ0IsRUFDaEIsT0FBTyxHQUFHLE9BQU8sQ0FBQyxPQUFPLEVBQ3pCLE9BQWlCLEVBUWhCLEVBQUU7UUFDSCxNQUFNLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQyxPQUFPLENBQUMsZUFBZSxFQUFFLEtBQUssQ0FBQyxDQUFBO1FBQ2hFLE1BQU0sc0JBQXNCLEdBQUcsQ0FBQSxPQUFPLGFBQVAsT0FBTyx1QkFBUCxPQUFPLENBQUUsU0FBUyxFQUFDLENBQUMsQ0FBQyxNQUFNLE1BQU0sQ0FBQyxTQUFTLENBQUMsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUE7UUFFMUcsa0JBQWtCO1FBQ2xCLE1BQU0sYUFBYSxHQUFHLE1BQU0sb0JBQW9CLENBQUMsS0FBSyxFQUFFLGVBQWUsRUFBRSxVQUFVLENBQUMsQ0FBQTtRQUNwRixNQUFNLGNBQWMsR0FBRyxNQUFNLFVBQVUsQ0FBQyxLQUFLLEVBQUUsV0FBVyxDQUFDLENBQUE7UUFDM0QsTUFBTSw4QkFBOEIsR0FBRyxzQkFBc0I7WUFDM0QsQ0FBQyxDQUFDLE1BQU0sVUFBVSxDQUFDLHNCQUFzQixFQUFFLFdBQVcsQ0FBQztZQUN2RCxDQUFDLENBQUMsU0FBUyxDQUFBO1FBRWIsc0ZBQXNGO1FBQ3RGLE1BQU0sb0JBQW9CLENBQUMsS0FBSyxFQUFFLHdCQUF3QixDQUFDLE9BQU8sQ0FBQyxFQUFFLFVBQVUsQ0FBQyxDQUFBO1FBRWhGLDBFQUEwRTtRQUMxRSxJQUFJLENBQUMsTUFBTSxFQUFFO1lBQ1gsTUFBTSxjQUFjLEdBQUcsTUFBTSxPQUFPLENBQUMsT0FBTyxDQUMxQyxVQUFVLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFDMUIsd0JBQXdCLEVBQ3hCLFdBQVcsRUFDWCxlQUFlLENBQ2hCLENBQUE7WUFDRCxNQUFNLGNBQWMsQ0FBQyxJQUFJLEVBQUUsQ0FBQTtTQUM1QjtRQUVELE1BQU0sV0FBVyxHQUFHO1lBQ2xCLElBQUksRUFBRSxnQkFBZ0IsQ0FBQyxRQUFRO1lBQy9CLEVBQUUsRUFBRSxnQkFBZ0IsQ0FBQyxFQUFFO1lBQ3ZCLEtBQUssRUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEtBQUssQ0FBQztZQUM3QyxJQUFJLEVBQUUsS0FBSyxDQUFDLE9BQU87WUFDbkIsUUFBUSxFQUFFLFNBQVMsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDO1lBQ3ZDLElBQUksRUFBRSxDQUFDO1NBQ1IsQ0FBQTtRQUVELE1BQU0sbUJBQW1CLEdBQWtDLE1BQU0sS0FBSyxDQUFDLGVBQWUsQ0FBQyxXQUFXLENBQUMsQ0FBQTtRQUNuRyxNQUFNLG1CQUFtQixDQUFDLElBQUksRUFBRSxDQUFBO1FBRWhDLE1BQU0sWUFBWSxHQUFHLE1BQU0sVUFBVSxDQUFDLEtBQUssRUFBRSxVQUFVLENBQUMsQ0FBQTtRQUN4RCxNQUFNLGFBQWEsR0FBRyxNQUFNLFVBQVUsQ0FBQyxLQUFLLEVBQUUsV0FBVyxDQUFDLENBQUE7UUFDMUQsTUFBTSw2QkFBNkIsR0FBRyxzQkFBc0I7WUFDMUQsQ0FBQyxDQUFDLE1BQU0sVUFBVSxDQUFDLHNCQUFzQixFQUFFLFdBQVcsQ0FBQztZQUN2RCxDQUFDLENBQUMsU0FBUyxDQUFBO1FBRWIsT0FBTztZQUNMLFlBQVk7WUFDWixhQUFhO1lBQ2IsYUFBYTtZQUNiLGNBQWM7WUFDZCw4QkFBOEI7WUFDOUIsNkJBQTZCO1NBQzlCLENBQUE7SUFDSCxDQUFDLENBQUE7SUFFRCxNQUFNLENBQUMsS0FBSztRQUNWLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQ2xCO1FBQUEsQ0FBQyxLQUFLLENBQUMsR0FBRyxNQUFNLE1BQU0sQ0FBQyxVQUFVLEVBQUUsQ0FBQTtRQUVwQyxtRUFBbUU7UUFDbkUsTUFBTSxRQUFRLEdBQXFCO1lBQ2pDLGNBQWMsRUFBRSxNQUFNO1lBQ3RCLGNBQWMsRUFBRSxDQUFDO1lBQ2pCLGVBQWUsRUFBRSxNQUFNO1lBQ3ZCLGVBQWUsRUFBRSxDQUFDO1lBQ2xCLE1BQU0sRUFBRSxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsU0FBUyxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDO1lBQzVELElBQUksRUFBRSxTQUFTO1NBQ2hCLENBQUE7UUFFRCxNQUFNLEVBQ0osSUFBSSxFQUFFLEVBQUUsV0FBVyxFQUFFLEdBQ3RCLEdBQUcsTUFBTSxLQUFLLENBQUMsR0FBRyxDQUFnQixHQUFHLEdBQUcsSUFBSSxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQTtRQUV0RSxLQUFLLEdBQUcsUUFBUSxDQUFDLFdBQVcsQ0FBQyxHQUFHLEVBQUUsQ0FBQTtRQUVsQyxLQUFLLEdBQUcsTUFBTSxtQkFBbUIsQ0FBQyxLQUFLLEVBQUUsS0FBSyxFQUFFO1lBQzlDLFdBQVcsQ0FBQyxTQUFTLEVBQUUsWUFBWSxDQUFDO1lBQ3BDLFdBQVcsQ0FBQyxTQUFTLEVBQUUsWUFBWSxDQUFDO1lBQ3BDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsWUFBWSxDQUFDO1lBQy9CLFdBQVcsQ0FBQyxNQUFNLEVBQUUsV0FBVyxDQUFDO1lBQ2hDLFdBQVcsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQzdCLFdBQVcsQ0FBQyxTQUFTLEVBQUUsV0FBVyxDQUFDO1lBQ25DLFdBQVcsQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDO1NBQzlCLENBQUMsQ0FBQTtRQUVGLHFDQUFxQztRQUNyQyxNQUFNLGVBQWUsR0FBRyxNQUFNLFVBQVUsQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBO1FBQ2pFLG1IQUFtSDtRQUNuSCxNQUFNLENBQUMsQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUE7UUFFcEcsMEhBQTBIO1FBQzFILHFFQUFxRTtRQUNyRSxNQUFNLGdCQUFnQixHQUFHLE1BQU0sVUFBVSxDQUFDLEtBQUssRUFBRSxZQUFZLENBQUMsQ0FBQTtRQUM5RCxNQUFNLENBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLFNBQVMsRUFBRSxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUE7UUFDbkYsTUFBTSxnQkFBZ0IsR0FBRyxNQUFNLFVBQVUsQ0FBQyxLQUFLLEVBQUUsWUFBWSxDQUFDLENBQUE7UUFDOUQsTUFBTSxDQUFDLENBQUMsZ0JBQWdCLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxTQUFTLEVBQUUsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFBO1FBQ25GLE1BQU0saUJBQWlCLEdBQUcsTUFBTSxVQUFVLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBO1FBQzNELE1BQU0sQ0FBQyxDQUFDLGlCQUFpQixDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQTtRQUM3RSxNQUFNLGdCQUFnQixHQUFHLE1BQU0sVUFBVSxDQUFDLEtBQUssRUFBRSxZQUFZLENBQUMsQ0FBQTtRQUM5RCxNQUFNLENBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUE7UUFDOUUsTUFBTSxlQUFlLEdBQUcsTUFBTSxVQUFVLENBQUMsS0FBSyxFQUFFLFdBQVcsQ0FBQyxDQUFBO1FBQzVELE1BQU0sQ0FBQyxDQUFDLGVBQWUsQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLFNBQVMsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUE7UUFDakYsTUFBTSxlQUFlLEdBQUcsTUFBTSxVQUFVLENBQUMsS0FBSyxFQUFFLFdBQVcsQ0FBQyxDQUFBO1FBQzVELE1BQU0sQ0FBQyxDQUFDLGVBQWUsQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLE1BQU0sRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUE7UUFDOUUsTUFBTSxrQkFBa0IsR0FBRyxNQUFNLFVBQVUsQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUE7UUFDMUQsTUFBTSxDQUFDLENBQUMsa0JBQWtCLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFBO0lBQ2hGLENBQUMsQ0FBQyxDQUFBO0lBRUYsS0FBSyxNQUFNLFNBQVMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFO1FBQ2pDLEtBQUssTUFBTSxJQUFJLElBQUksQ0FBQyxTQUFTLEVBQUUsVUFBVSxDQUFDLEVBQUU7WUFDMUMsUUFBUSxDQUFDLEdBQUcsa0JBQWtCLENBQUMsQ0FBQyxDQUFDLElBQUksU0FBUyxJQUFJLElBQUksTUFBTSxFQUFFLEdBQUcsRUFBRTtnQkFDakUsUUFBUSxDQUFDLGdCQUFnQixFQUFFLEdBQUcsRUFBRTtvQkFDOUIsRUFBRSxDQUFDLGdCQUFnQixFQUFFLEtBQUssSUFBSSxFQUFFO3dCQUM5QixNQUFNLFFBQVEsR0FBcUI7NEJBQ2pDLGNBQWMsRUFBRSxNQUFNOzRCQUN0QixjQUFjLEVBQUUsQ0FBQzs0QkFDakIsZUFBZSxFQUFFLE1BQU07NEJBQ3ZCLGVBQWUsRUFBRSxDQUFDOzRCQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQzs0QkFDdkQsSUFBSTs0QkFDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87NEJBQ3hCLGlCQUFpQixFQUFFLFFBQVE7NEJBQzNCLFFBQVEsRUFBRSxLQUFLOzRCQUNmLFNBQVM7NEJBQ1QscUJBQXFCLEVBQUUsSUFBSTt5QkFDNUIsQ0FBQTt3QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO3dCQUUxQyxNQUFNLFFBQVEsR0FBaUMsTUFBTSxLQUFLLENBQUMsR0FBRyxDQUFnQixHQUFHLEdBQUcsSUFBSSxXQUFXLEVBQUUsQ0FBQyxDQUFBO3dCQUN0RyxNQUFNLEVBQ0osSUFBSSxFQUFFLEVBQUUsS0FBSyxFQUFFLGFBQWEsRUFBRSx3QkFBd0IsRUFBRSxnQkFBZ0IsRUFBRSxFQUMxRSxNQUFNLEdBQ1AsR0FBRyxRQUFRLENBQUE7d0JBRVosTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7d0JBQzVCLE1BQU0sQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUMsQ0FBQTt3QkFDdkQsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFBO3dCQUVyRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7NEJBQ3JCLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsZUFBZSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBO3lCQUM5Rjs2QkFBTTs0QkFDTCxNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLGtCQUFrQixDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBO3lCQUNqRzt3QkFFRCxNQUFNLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUE7d0JBQzVDLE1BQU0sQ0FBQyxnQkFBZ0IsYUFBaEIsZ0JBQWdCLHVCQUFoQixnQkFBZ0IsQ0FBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUE7d0JBRS9ELE1BQU0sRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxhQUFhLEVBQUUsR0FBRyxNQUFNLFdBQVcsQ0FDdEYsZ0JBQWlCLEVBQ2pCLFlBQVksRUFDWixZQUFZLENBQ2IsQ0FBQTt3QkFFRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7NEJBQ3JCLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQTs0QkFDdEUsZUFBZSxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQTt5QkFDbEc7NkJBQU07NEJBQ0wsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBOzRCQUN4RSxlQUFlLENBQUMsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFlBQVksRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFBO3lCQUNoRztvQkFDSCxDQUFDLENBQUMsQ0FBQTtvQkFFRixFQUFFLENBQUMsNkJBQTZCLEVBQUUsS0FBSyxJQUFJLEVBQUU7d0JBQzNDLE1BQU0sUUFBUSxHQUFxQjs0QkFDakMsY0FBYyxFQUFFLE1BQU07NEJBQ3RCLGNBQWMsRUFBRSxDQUFDOzRCQUNqQixlQUFlLEVBQUUsTUFBTTs0QkFDdkIsZUFBZSxFQUFFLENBQUM7NEJBQ2xCLE1BQU0sRUFBRSxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDOzRCQUN2RCxJQUFJOzRCQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTzs0QkFDeEIsaUJBQWlCLEVBQUUsUUFBUTs0QkFDM0IsUUFBUSxFQUFFLEtBQUs7NEJBQ2YsU0FBUzt5QkFDVixDQUFBO3dCQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7d0JBRTFDLE1BQU0sUUFBUSxHQUFpQyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7d0JBQ3RHLE1BQU0sRUFDSixJQUFJLEVBQUUsRUFBRSxLQUFLLEVBQUUsYUFBYSxFQUFFLHdCQUF3QixFQUFFLGdCQUFnQixFQUFFLEVBQzFFLE1BQU0sR0FDUCxHQUFHLFFBQVEsQ0FBQTt3QkFFWixNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTt3QkFDNUIsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFBO3dCQUN2RCxNQUFNLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUE7d0JBRXJELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTs0QkFDckIsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7eUJBQzlGOzZCQUFNOzRCQUNMLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7eUJBQ2pHO3dCQUVELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3QkFDNUMsTUFBTSxDQUFDLGdCQUFnQixhQUFoQixnQkFBZ0IsdUJBQWhCLGdCQUFnQixDQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsd0JBQXdCLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUE7d0JBRWhGLE1BQU0sRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxhQUFhLEVBQUUsR0FBRyxNQUFNLFdBQVcsQ0FDdEYsZ0JBQWlCLEVBQ2pCLFlBQVksRUFDWixZQUFZLENBQ2IsQ0FBQTt3QkFFRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7NEJBQ3JCLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQTs0QkFDdEUsZUFBZSxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQTt5QkFDbEc7NkJBQU07NEJBQ0wsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBOzRCQUN4RSxlQUFlLENBQUMsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFlBQVksRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFBO3lCQUNoRztvQkFDSCxDQUFDLENBQUMsQ0FBQTtvQkFFRixFQUFFLENBQUMsNEJBQTRCLEVBQUUsS0FBSyxJQUFJLEVBQUU7d0JBQzFDLE1BQU0sTUFBTSxHQUFHLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQTt3QkFFN0QsTUFBTSxLQUFLLEdBQUcsZUFBZSxFQUFFLENBQUE7d0JBRS9CLE1BQU0sTUFBTSxHQUFpQjs0QkFDM0IsT0FBTyxFQUFFO2dDQUNQLEtBQUssRUFBRSxZQUFZLENBQUMsT0FBTztnQ0FDM0IsTUFBTSxFQUFFLFVBQVU7Z0NBQ2xCLFVBQVUsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksSUFBSSxFQUFFLENBQUMsT0FBTyxFQUFFLEdBQUcsSUFBSSxHQUFHLFFBQVEsQ0FBQyxDQUFDLFFBQVEsRUFBRTtnQ0FDekUsS0FBSzs2QkFDTjs0QkFDRCxPQUFPLEVBQUUsd0JBQXdCOzRCQUNqQyxXQUFXLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDLE9BQU8sRUFBRSxHQUFHLElBQUksR0FBRyxRQUFRLENBQUMsQ0FBQyxRQUFRLEVBQUU7eUJBQzNFLENBQUE7d0JBRUQsTUFBTSxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLEdBQUcsaUJBQWlCLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRSxlQUFlLEVBQUUsQ0FBQyxDQUFDLENBQUE7d0JBRTdGLE1BQU0sU0FBUyxHQUFHLE1BQU0sS0FBSyxDQUFDLGNBQWMsQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFBO3dCQUVuRSxNQUFNLFFBQVEsR0FBcUI7NEJBQ2pDLGNBQWMsRUFBRSxNQUFNOzRCQUN0QixjQUFjLEVBQUUsQ0FBQzs0QkFDakIsZUFBZSxFQUFFLE1BQU07NEJBQ3ZCLGVBQWUsRUFBRSxDQUFDOzRCQUNsQixNQUFNOzRCQUNOLElBQUk7NEJBQ0osU0FBUyxFQUFFLEtBQUssQ0FBQyxPQUFPOzRCQUN4QixpQkFBaUIsRUFBRSxRQUFROzRCQUMzQixRQUFRLEVBQUUsS0FBSzs0QkFDZixTQUFTOzRCQUNULGVBQWUsRUFBRSxTQUFTOzRCQUMxQixZQUFZLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsUUFBUSxFQUFFOzRCQUM5QyxnQkFBZ0IsRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxRQUFRLEVBQUU7NEJBQ3RELGlCQUFpQixFQUFFLE1BQU0sQ0FBQyxXQUFXLENBQUMsUUFBUSxFQUFFOzRCQUNoRCxXQUFXLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFOzRCQUM1QyxxQkFBcUIsRUFBRSxJQUFJO3lCQUM1QixDQUFBO3dCQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7d0JBRTFDLE1BQU0sUUFBUSxHQUFpQyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7d0JBQ3RHLE1BQU0sRUFDSixJQUFJLEVBQUUsRUFBRSxLQUFLLEVBQUUsYUFBYSxFQUFFLHdCQUF3QixFQUFFLGdCQUFnQixFQUFFLEVBQzFFLE1BQU0sR0FDUCxHQUFHLFFBQVEsQ0FBQTt3QkFFWixNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTt3QkFDNUIsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFBO3dCQUN0RCxNQUFNLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUE7d0JBRXBELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTs0QkFDckIsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7eUJBQzlGOzZCQUFNOzRCQUNMLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7eUJBQ2pHO3dCQUVELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3QkFDNUMsTUFBTSxDQUFDLGdCQUFnQixhQUFoQixnQkFBZ0IsdUJBQWhCLGdCQUFnQixDQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQTt3QkFFL0QsTUFBTSxFQUFFLGFBQWEsRUFBRSxZQUFZLEVBQUUsY0FBYyxFQUFFLGFBQWEsRUFBRSxHQUFHLE1BQU0sV0FBVyxDQUN0RixnQkFBaUIsRUFDakIsWUFBWSxFQUNaLFlBQVksRUFDWixJQUFJLENBQ0wsQ0FBQTt3QkFFRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7NEJBQ3JCLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQTs0QkFDckUsZUFBZSxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQTt5QkFDbEc7NkJBQU07NEJBQ0wsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFBOzRCQUN2RSxlQUFlLENBQUMsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFlBQVksRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFBO3lCQUNoRztvQkFDSCxDQUFDLENBQUMsQ0FBQTtvQkFFRixFQUFFLENBQUMsY0FBYyxFQUFFLEtBQUssSUFBSSxFQUFFO3dCQUM1QixNQUFNLFFBQVEsR0FBcUI7NEJBQ2pDLGNBQWMsRUFBRSxNQUFNOzRCQUN0QixjQUFjLEVBQUUsQ0FBQzs0QkFDakIsZUFBZSxFQUFFLEtBQUs7NEJBQ3RCLGVBQWUsRUFBRSxDQUFDOzRCQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLElBQUksSUFBSSxTQUFTLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDOzRCQUNyRixJQUFJOzRCQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTzs0QkFDeEIsaUJBQWlCLEVBQUUsUUFBUTs0QkFDM0IsUUFBUSxFQUFFLEtBQUs7NEJBQ2YsU0FBUzs0QkFDVCxxQkFBcUIsRUFBRSxJQUFJO3lCQUM1QixDQUFBO3dCQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7d0JBRTFDLE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUFDLEdBQUcsQ0FBZ0IsR0FBRyxHQUFHLElBQUksV0FBVyxFQUFFLENBQUMsQ0FBQTt3QkFDeEUsTUFBTSxFQUNKLElBQUksRUFBRSxFQUFFLEtBQUssRUFBRSxnQkFBZ0IsRUFBRSxFQUNqQyxNQUFNLEdBQ1AsR0FBRyxRQUFRLENBQUE7d0JBRVosTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7d0JBQzVCLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3QkFFNUMsTUFBTSxFQUFFLGFBQWEsRUFBRSxZQUFZLEVBQUUsY0FBYyxFQUFFLGFBQWEsRUFBRSxHQUFHLE1BQU0sV0FBVyxDQUN0RixnQkFBaUIsRUFDakIsWUFBWSxFQUNaLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQ2pCLENBQUE7d0JBRUQsSUFBSSxJQUFJLElBQUksU0FBUyxFQUFFOzRCQUNyQixNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUE7NEJBQzFFLGVBQWUsQ0FBQyxjQUFjLEVBQUUsYUFBYSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFBO3lCQUN0Rzs2QkFBTTs0QkFDTCw4RkFBOEY7NEJBQzlGLGVBQWUsQ0FBQyxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsWUFBWSxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUE7eUJBQ2hHO29CQUNILENBQUMsQ0FBQyxDQUFBO29CQUVGLEVBQUUsQ0FBQywwQkFBMEIsRUFBRSxLQUFLLElBQUksRUFBRTt3QkFDeEMsc0RBQXNEO3dCQUN0RCxNQUFNLFFBQVEsR0FBcUI7NEJBQ2pDLGNBQWMsRUFBRSxNQUFNOzRCQUN0QixjQUFjLEVBQUUsQ0FBQzs0QkFDakIsZUFBZSxFQUFFLEtBQUs7NEJBQ3RCLGVBQWUsRUFBRSxDQUFDOzRCQUNsQixNQUFNLEVBQ0osSUFBSSxJQUFJLFNBQVM7Z0NBQ2YsQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUM7Z0NBQ3BELENBQUMsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsS0FBSyxDQUFDOzRCQUNwRCxJQUFJOzRCQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTzs0QkFDeEIsaUJBQWlCLEVBQUUsUUFBUTs0QkFDM0IsUUFBUSxFQUFFLEtBQUs7NEJBQ2YsU0FBUzs0QkFDVCxxQkFBcUIsRUFBRSxJQUFJO3lCQUM1QixDQUFBO3dCQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7d0JBRTFDLE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUFDLEdBQUcsQ0FBZ0IsR0FBRyxHQUFHLElBQUksV0FBVyxFQUFFLENBQUMsQ0FBQTt3QkFDeEUsTUFBTSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxRQUFRLENBQUE7d0JBRWpDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBO3dCQUM1QixNQUFNLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBO3dCQUVqRCxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3QkFFdEMsTUFBTSxrQkFBa0IsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQzs2QkFDckMsT0FBTyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFFLENBQUM7NkJBQzdCLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7NkJBQ2pDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7NkJBQzVDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBO3dCQUM1RCxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQTt3QkFDM0MsTUFBTSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsQ0FBQyxDQUFBO3dCQUV2QyxNQUFNLG1CQUFtQixHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDOzZCQUN0QyxPQUFPLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUUsQ0FBQzs2QkFDN0IsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQzs2QkFDbEMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQzs2QkFDN0MsTUFBTSxDQUFDLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUE7d0JBQzVELE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFBO3dCQUM1QyxNQUFNLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDLENBQUE7d0JBRXpDLE1BQU0sRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxhQUFhLEVBQUUsR0FBRyxNQUFNLFdBQVcsQ0FDdEYsSUFBSSxDQUFDLGdCQUFpQixFQUN0QixZQUFZLEVBQ1osS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FDakIsQ0FBQTt3QkFFRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7NEJBQ3JCLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQTs0QkFDMUUsZUFBZSxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFBO3lCQUMzRzs2QkFBTTs0QkFDTCw4RkFBOEY7NEJBQzlGLGVBQWUsQ0FBQyxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsWUFBWSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFBO3lCQUNyRztvQkFDSCxDQUFDLENBQUMsQ0FBQTtvQkFFRixFQUFFLENBQUMsc0NBQXNDLEVBQUUsS0FBSyxJQUFJLEVBQUU7d0JBQ3BELE1BQU0sS0FBSyxHQUFHLGVBQWUsRUFBRSxDQUFBO3dCQUUvQixNQUFNLE1BQU0sR0FDVixJQUFJLElBQUksU0FBUzs0QkFDZixDQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLFNBQVMsQ0FBQzs0QkFDcEQsQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQTt3QkFFcEQsTUFBTSxNQUFNLEdBQWlCOzRCQUMzQixPQUFPLEVBQUU7Z0NBQ1AsS0FBSyxFQUFFLFlBQVksQ0FBQyxPQUFPO2dDQUMzQixNQUFNLEVBQUUsZUFBZTtnQ0FDdkIsVUFBVSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQyxPQUFPLEVBQUUsR0FBRyxJQUFJLEdBQUcsUUFBUSxDQUFDLENBQUMsUUFBUSxFQUFFO2dDQUN6RSxLQUFLOzZCQUNOOzRCQUNELE9BQU8sRUFBRSx3QkFBd0I7NEJBQ2pDLFdBQVcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksSUFBSSxFQUFFLENBQUMsT0FBTyxFQUFFLEdBQUcsSUFBSSxHQUFHLFFBQVEsQ0FBQyxDQUFDLFFBQVEsRUFBRTt5QkFDM0UsQ0FBQTt3QkFFRCxNQUFNLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsR0FBRyxpQkFBaUIsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFLGVBQWUsRUFBRSxDQUFDLENBQUMsQ0FBQTt3QkFFN0YsTUFBTSxTQUFTLEdBQUcsTUFBTSxLQUFLLENBQUMsY0FBYyxDQUFDLE1BQU0sRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUE7d0JBRW5FLHNEQUFzRDt3QkFDdEQsTUFBTSxRQUFRLEdBQXFCOzRCQUNqQyxjQUFjLEVBQUUsTUFBTTs0QkFDdEIsY0FBYyxFQUFFLENBQUM7NEJBQ2pCLGVBQWUsRUFBRSxLQUFLOzRCQUN0QixlQUFlLEVBQUUsQ0FBQzs0QkFDbEIsTUFBTTs0QkFDTixJQUFJOzRCQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTzs0QkFDeEIsaUJBQWlCLEVBQUUsUUFBUTs0QkFDM0IsUUFBUSxFQUFFLEtBQUs7NEJBQ2YsU0FBUzs0QkFDVCxlQUFlLEVBQUUsU0FBUzs0QkFDMUIsWUFBWSxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRTs0QkFDOUMsZ0JBQWdCLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsUUFBUSxFQUFFOzRCQUN0RCxpQkFBaUIsRUFBRSxNQUFNLENBQUMsV0FBVyxDQUFDLFFBQVEsRUFBRTs0QkFDaEQsV0FBVyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRTs0QkFDNUMscUJBQXFCLEVBQUUsSUFBSTt5QkFDNUIsQ0FBQTt3QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO3dCQUUxQyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7d0JBQ3hFLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFBO3dCQUVqQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTt3QkFDNUIsTUFBTSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3QkFDakQsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUE7d0JBRXRDLE1BQU0sRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxhQUFhLEVBQUUsR0FBRyxNQUFNLFdBQVcsQ0FDdEYsSUFBSSxDQUFDLGdCQUFpQixFQUN0QixZQUFZLEVBQ1osS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFDaEIsSUFBSSxDQUNMLENBQUE7d0JBRUQsSUFBSSxJQUFJLElBQUksU0FBUyxFQUFFOzRCQUNyQixNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUE7NEJBQzFFLGVBQWUsQ0FBQyxjQUFjLEVBQUUsYUFBYSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQTt5QkFDM0c7NkJBQU07NEJBQ0wsOEZBQThGOzRCQUM5RixlQUFlLENBQUMsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFlBQVksRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQTt5QkFDckc7b0JBQ0gsQ0FBQyxDQUFDLENBQUE7b0JBRUYsRUFBRSxDQUFDLGNBQWMsRUFBRSxLQUFLLElBQUksRUFBRTt3QkFDNUIsTUFBTSxRQUFRLEdBQXFCOzRCQUNqQyxjQUFjLEVBQUUsS0FBSzs0QkFDckIsY0FBYyxFQUFFLENBQUM7NEJBQ2pCLGVBQWUsRUFBRSxLQUFLOzRCQUN0QixlQUFlLEVBQUUsQ0FBQzs0QkFDbEIsTUFBTSxFQUNKLElBQUksSUFBSSxTQUFTO2dDQUNmLENBQUMsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDO2dDQUM5QyxDQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLE9BQU8sQ0FBQzs0QkFDckQsSUFBSTs0QkFDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87NEJBQ3hCLGlCQUFpQixFQUFFLFFBQVE7NEJBQzNCLFFBQVEsRUFBRSxLQUFLOzRCQUNmLFNBQVM7NEJBQ1QscUJBQXFCLEVBQUUsSUFBSTt5QkFDNUIsQ0FBQTt3QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO3dCQUUxQyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7d0JBQ3hFLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFBO3dCQUVqQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTt3QkFDNUIsTUFBTSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3QkFFakQsTUFBTSxFQUFFLGFBQWEsRUFBRSxZQUFZLEVBQUUsY0FBYyxFQUFFLGFBQWEsRUFBRSxHQUFHLE1BQU0sV0FBVyxDQUN0RixJQUFJLENBQUMsZ0JBQWlCLEVBQ3RCLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQ2hCLFdBQVcsQ0FDWixDQUFBO3dCQUVELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTs0QkFDckIsbUNBQW1DOzRCQUNuQyxNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsQ0FBQyxXQUFXLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFBOzRCQUN4RyxlQUFlLENBQUMsY0FBYyxFQUFFLGFBQWEsRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFdBQVcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQTt5QkFDdEc7NkJBQU07NEJBQ0wsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFBOzRCQUMxRSw4RUFBOEU7eUJBQy9FO29CQUNILENBQUMsQ0FBQyxDQUFBO29CQUVGLEVBQUUsQ0FBQywyQkFBMkIsRUFBRSxLQUFLLElBQUksRUFBRTs7d0JBQ3pDLE1BQU0sUUFBUSxHQUFxQjs0QkFDakMsY0FBYyxFQUFFLEtBQUs7NEJBQ3JCLGNBQWMsRUFBRSxDQUFDOzRCQUNqQixlQUFlLEVBQUUsS0FBSzs0QkFDdEIsZUFBZSxFQUFFLENBQUM7NEJBQ2xCLE1BQU0sRUFDSixJQUFJLElBQUksU0FBUztnQ0FDZixDQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQztnQ0FDOUMsQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxPQUFPLENBQUM7NEJBQ3JELElBQUk7NEJBQ0osU0FBUyxFQUFFLEtBQUssQ0FBQyxPQUFPOzRCQUN4QixpQkFBaUIsRUFBRSxJQUFJLElBQUksVUFBVSxDQUFDLENBQUMsQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLFFBQVE7NEJBQ2pFLFFBQVEsRUFBRSxLQUFLOzRCQUNmLFNBQVM7NEJBQ1QscUJBQXFCLEVBQUUsS0FBSzt5QkFDN0IsQ0FBQTt3QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO3dCQUUxQyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7d0JBQ3hFLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFBO3dCQUVqQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTt3QkFDNUIsTUFBTSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3QkFDakQsTUFBTSxDQUFDLE1BQUEsSUFBSSxDQUFDLGdCQUFnQiwwQ0FBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFBO3dCQUVyRixNQUFNLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFLEdBQUcsTUFBTSxXQUFXLENBQ3RGLElBQUksQ0FBQyxnQkFBaUIsRUFDdEIsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFDaEIsV0FBVyxDQUNaLENBQUE7d0JBRUQsSUFBSSxJQUFJLElBQUksU0FBUyxFQUFFOzRCQUNyQixtQ0FBbUM7NEJBQ25DLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUE7NEJBQ3hHLGVBQWUsQ0FBQyxjQUFjLEVBQUUsYUFBYSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsV0FBVyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFBO3lCQUN0Rzs2QkFBTTs0QkFDTCxNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUE7NEJBQzFFLDhFQUE4RTt5QkFDL0U7b0JBQ0gsQ0FBQyxDQUFDLENBQUE7b0JBRUYsRUFBRSxDQUFDLGVBQWUsRUFBRSxLQUFLLElBQUksRUFBRTt3QkFDN0IsTUFBTSxRQUFRLEdBQXFCOzRCQUNqQyxjQUFjLEVBQUUsTUFBTTs0QkFDdEIsY0FBYyxFQUFFLENBQUM7NEJBQ2pCLGVBQWUsRUFBRSxLQUFLOzRCQUN0QixlQUFlLEVBQUUsQ0FBQzs0QkFDbEIsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUM7NEJBQ3RELElBQUk7NEJBQ0osU0FBUyxFQUFFLEtBQUssQ0FBQyxPQUFPOzRCQUN4QixpQkFBaUIsRUFBRSxRQUFROzRCQUMzQixRQUFRLEVBQUUsS0FBSzs0QkFDZixTQUFTOzRCQUNULHFCQUFxQixFQUFFLElBQUk7eUJBQzVCLENBQUE7d0JBRUQsTUFBTSxXQUFXLEdBQUcsRUFBRSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQTt3QkFFMUMsTUFBTSxRQUFRLEdBQUcsTUFBTSxLQUFLLENBQUMsR0FBRyxDQUFnQixHQUFHLEdBQUcsSUFBSSxXQUFXLEVBQUUsQ0FBQyxDQUFBO3dCQUN4RSxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLFFBQVEsQ0FBQTt3QkFFakMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7d0JBQzVCLE1BQU0sQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUE7d0JBRWpELE1BQU0sRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxhQUFhLEVBQUUsR0FBRyxNQUFNLFdBQVcsQ0FDdEYsSUFBSSxDQUFDLGdCQUFpQixFQUN0QixLQUFLLENBQUMsQ0FBQyxDQUFFLEVBQ1QsV0FBVyxDQUNaLENBQUE7d0JBRUQsSUFBSSxJQUFJLElBQUksU0FBUyxFQUFFOzRCQUNyQixNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUE7NEJBQ3RFLGVBQWUsQ0FBQyxjQUFjLEVBQUUsYUFBYSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsV0FBVyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFBO3lCQUN0Rzs2QkFBTTs0QkFDTCxNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUE7NEJBQ3hFLGVBQWUsQ0FBQyxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBRSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFBO3lCQUNsRztvQkFDSCxDQUFDLENBQUMsQ0FBQTtvQkFFRixFQUFFLENBQUMsZUFBZSxFQUFFLEtBQUssSUFBSSxFQUFFO3dCQUM3QixNQUFNLFFBQVEsR0FBcUI7NEJBQ2pDLGNBQWMsRUFBRSxNQUFNOzRCQUN0QixjQUFjLEVBQUUsQ0FBQzs0QkFDakIsZUFBZSxFQUFFLE1BQU07NEJBQ3ZCLGVBQWUsRUFBRSxDQUFDOzRCQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQzs0QkFDdkQsSUFBSTs0QkFDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87NEJBQ3hCLGlCQUFpQixFQUFFLFFBQVE7NEJBQzNCLFFBQVEsRUFBRSxLQUFLOzRCQUNmLFNBQVM7NEJBQ1QscUJBQXFCLEVBQUUsSUFBSTt5QkFDNUIsQ0FBQTt3QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO3dCQUUxQyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7d0JBQ3hFLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFBO3dCQUVqQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTt3QkFDNUIsTUFBTSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3QkFFakQsTUFBTSxFQUFFLGFBQWEsRUFBRSxZQUFZLEVBQUUsY0FBYyxFQUFFLGFBQWEsRUFBRSxHQUFHLE1BQU0sV0FBVyxDQUN0RixJQUFJLENBQUMsZ0JBQWlCLEVBQ3RCLFlBQVksRUFDWixLQUFLLENBQUMsQ0FBQyxDQUFFLENBQ1YsQ0FBQTt3QkFFRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7NEJBQ3JCLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQTs0QkFDdEUsZUFBZSxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUE7eUJBQ25HOzZCQUFNOzRCQUNMLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQTs0QkFDeEUsZUFBZSxDQUFDLGFBQWEsRUFBRSxZQUFZLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxZQUFZLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUE7eUJBQ3JHO29CQUNILENBQUMsQ0FBQyxDQUFBO29CQUVGLElBQUksU0FBUyxJQUFJLE9BQU8sRUFBRTt3QkFDeEIsRUFBRSxDQUFDLHdCQUF3QixFQUFFLEtBQUssSUFBSSxFQUFFOzRCQUN0QyxNQUFNLFFBQVEsR0FBcUI7Z0NBQ2pDLGNBQWMsRUFBRSxNQUFNO2dDQUN0QixjQUFjLEVBQUUsQ0FBQztnQ0FDakIsZUFBZSxFQUFFLE1BQU07Z0NBQ3ZCLGVBQWUsRUFBRSxDQUFDO2dDQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQztnQ0FDdkQsSUFBSTtnQ0FDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87Z0NBQ3hCLGlCQUFpQixFQUFFLFFBQVE7Z0NBQzNCLFFBQVEsRUFBRSxLQUFLO2dDQUNmLFNBQVMsRUFBRSxPQUFPO2dDQUNsQixTQUFTLEVBQUUsSUFBSTtnQ0FDZixxQkFBcUIsRUFBRSxJQUFJOzZCQUM1QixDQUFBOzRCQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7NEJBRTFDLE1BQU0sUUFBUSxHQUFpQyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7NEJBQ3RHLE1BQU0sRUFDSixJQUFJLEVBQUUsRUFBRSxLQUFLLEVBQUUsYUFBYSxFQUFFLHdCQUF3QixFQUFFLGdCQUFnQixFQUFFLEtBQUssRUFBRSxFQUNqRixNQUFNLEdBQ1AsR0FBRyxRQUFRLENBQUE7NEJBRVosTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7NEJBQzVCLE1BQU0sQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUMsQ0FBQTs0QkFDdkQsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFBOzRCQUVyRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7Z0NBQ3JCLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsZUFBZSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBOzZCQUM5RjtpQ0FBTTtnQ0FDTCxNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLGtCQUFrQixDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBOzZCQUNqRzs0QkFFRCxNQUFNLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUE7NEJBRTVDLEtBQUssTUFBTSxDQUFDLElBQUksS0FBSyxFQUFFO2dDQUNyQixLQUFLLE1BQU0sSUFBSSxJQUFJLENBQUMsRUFBRTtvQ0FDcEIsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFBO2lDQUN0Qzs2QkFDRjs0QkFFRCxNQUFNLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFLEdBQUcsTUFBTSxXQUFXLENBQ3RGLFFBQVEsQ0FBQyxJQUFJLENBQUMsZ0JBQWlCLEVBQy9CLFlBQVksRUFDWixZQUFhLENBQ2QsQ0FBQTs0QkFFRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7Z0NBQ3JCLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQTtnQ0FDdEUsZUFBZSxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQTs2QkFDbEc7aUNBQU07Z0NBQ0wsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO2dDQUN4RSxlQUFlLENBQUMsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFlBQVksRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFBOzZCQUNoRzt3QkFDSCxDQUFDLENBQUMsQ0FBQTt3QkFFRixFQUFFLENBQUMsd0JBQXdCLEVBQUUsS0FBSyxJQUFJLEVBQUU7NEJBQ3RDLE1BQU0sUUFBUSxHQUFxQjtnQ0FDakMsY0FBYyxFQUFFLE1BQU07Z0NBQ3RCLGNBQWMsRUFBRSxDQUFDO2dDQUNqQixlQUFlLEVBQUUsTUFBTTtnQ0FDdkIsZUFBZSxFQUFFLENBQUM7Z0NBQ2xCLE1BQU0sRUFBRSxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDO2dDQUN2RCxJQUFJO2dDQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTztnQ0FDeEIsaUJBQWlCLEVBQUUsUUFBUTtnQ0FDM0IsUUFBUSxFQUFFLEtBQUs7Z0NBQ2YsU0FBUyxFQUFFLE9BQU87Z0NBQ2xCLFNBQVMsRUFBRSxJQUFJO2dDQUNmLHFCQUFxQixFQUFFLElBQUk7NkJBQzVCLENBQUE7NEJBRUQsTUFBTSxXQUFXLEdBQUcsRUFBRSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQTs0QkFFMUMsTUFBTSxRQUFRLEdBQWlDLE1BQU0sS0FBSyxDQUFDLEdBQUcsQ0FBZ0IsR0FBRyxHQUFHLElBQUksV0FBVyxFQUFFLENBQUMsQ0FBQTs0QkFDdEcsTUFBTSxFQUNKLElBQUksRUFBRSxFQUFFLEtBQUssRUFBRSxhQUFhLEVBQUUsd0JBQXdCLEVBQUUsZ0JBQWdCLEVBQUUsS0FBSyxFQUFFLEVBQ2pGLE1BQU0sR0FDUCxHQUFHLFFBQVEsQ0FBQTs0QkFFWixNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTs0QkFDNUIsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFBOzRCQUN2RCxNQUFNLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUE7NEJBRXJELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTtnQ0FDckIsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7NkJBQzlGO2lDQUFNO2dDQUNMLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7NkJBQ2pHOzRCQUVELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTs0QkFFNUMsS0FBSyxNQUFNLENBQUMsSUFBSSxLQUFLLEVBQUU7Z0NBQ3JCLEtBQUssTUFBTSxJQUFJLElBQUksQ0FBQyxFQUFFO29DQUNwQixNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUE7aUNBQ3RDOzZCQUNGOzRCQUVELE1BQU0sRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxhQUFhLEVBQUUsR0FBRyxNQUFNLFdBQVcsQ0FDdEYsUUFBUSxDQUFDLElBQUksQ0FBQyxnQkFBaUIsRUFDL0IsWUFBWSxFQUNaLFlBQWEsQ0FDZCxDQUFBOzRCQUVELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTtnQ0FDckIsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO2dDQUN0RSxlQUFlLENBQUMsY0FBYyxFQUFFLGFBQWEsRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFlBQVksRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFBOzZCQUNsRztpQ0FBTTtnQ0FDTCxNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUE7Z0NBQ3hFLGVBQWUsQ0FBQyxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsWUFBWSxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUE7NkJBQ2hHO3dCQUNILENBQUMsQ0FBQyxDQUFBO3dCQUVGLEVBQUUsQ0FBQyxtQ0FBbUMsRUFBRSxLQUFLLElBQUksRUFBRTs0QkFDakQsTUFBTSxRQUFRLEdBQXFCO2dDQUNqQyxjQUFjLEVBQUUsTUFBTTtnQ0FDdEIsY0FBYyxFQUFFLENBQUM7Z0NBQ2pCLGVBQWUsRUFBRSxNQUFNO2dDQUN2QixlQUFlLEVBQUUsQ0FBQztnQ0FDbEIsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUM7Z0NBQ3ZELElBQUk7Z0NBQ0osU0FBUyxFQUFFLEtBQUssQ0FBQyxPQUFPO2dDQUN4QixpQkFBaUIsRUFBRSxRQUFRO2dDQUMzQixRQUFRLEVBQUUsS0FBSztnQ0FDZixTQUFTLEVBQUUsT0FBTztnQ0FDbEIsa0JBQWtCLEVBQUUsSUFBSTtnQ0FDeEIscUJBQXFCLEVBQUUsSUFBSTs2QkFDNUIsQ0FBQTs0QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBOzRCQUUxQyxNQUFNLFFBQVEsR0FBaUMsTUFBTSxLQUFLLENBQUMsR0FBRyxDQUFnQixHQUFHLEdBQUcsSUFBSSxXQUFXLEVBQUUsQ0FBQyxDQUFBOzRCQUN0RyxNQUFNLEVBQ0osSUFBSSxFQUFFLEVBQUUsS0FBSyxFQUFFLGFBQWEsRUFBRSx3QkFBd0IsRUFBRSxnQkFBZ0IsRUFBRSxLQUFLLEVBQUUsRUFDakYsTUFBTSxHQUNQLEdBQUcsUUFBUSxDQUFBOzRCQUVaLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBOzRCQUM1QixNQUFNLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsRUFBRSxDQUFDLENBQUE7NEJBQ3ZELE1BQU0sQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQTs0QkFFckQsSUFBSSxJQUFJLElBQUksU0FBUyxFQUFFO2dDQUNyQixNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLGVBQWUsQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQTs2QkFDOUY7aUNBQU07Z0NBQ0wsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQTs2QkFDakc7NEJBRUQsTUFBTSxDQUFDLGdCQUFnQixDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBOzRCQUU1QyxJQUFJLFNBQVMsR0FBRyxLQUFLLENBQUE7NEJBQ3JCLElBQUksU0FBUyxHQUFHLEtBQUssQ0FBQTs0QkFDckIsS0FBSyxNQUFNLENBQUMsSUFBSSxLQUFLLEVBQUU7Z0NBQ3JCLEtBQUssTUFBTSxJQUFJLElBQUksQ0FBQyxFQUFFO29DQUNwQixJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksU0FBUyxFQUFFO3dDQUMxQixTQUFTLEdBQUcsSUFBSSxDQUFBO3FDQUNqQjtvQ0FDRCxJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksU0FBUyxFQUFFO3dDQUMxQixTQUFTLEdBQUcsSUFBSSxDQUFBO3FDQUNqQjtpQ0FDRjs2QkFDRjs0QkFFRCxNQUFNLENBQUMsU0FBUyxJQUFJLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFBOzRCQUV6QyxNQUFNLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFLEdBQUcsTUFBTSxXQUFXLENBQ3RGLFFBQVEsQ0FBQyxJQUFJLENBQUMsZ0JBQWlCLEVBQy9CLFlBQVksRUFDWixZQUFhLENBQ2QsQ0FBQTs0QkFFRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7Z0NBQ3JCLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQTtnQ0FDdEUsZUFBZSxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQTs2QkFDbEc7aUNBQU07Z0NBQ0wsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO2dDQUN4RSxlQUFlLENBQUMsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFlBQVksRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFBOzZCQUNoRzt3QkFDSCxDQUFDLENBQUMsQ0FBQTt3QkFFRixtRUFBbUU7d0JBQ25FLElBQUksSUFBSSxLQUFLLFNBQVMsRUFBRTs0QkFDdEIsRUFBRSxDQUFDLDRHQUE0RyxFQUFFLEtBQUssSUFBSSxFQUFFO2dDQUMxSCxNQUFNLFFBQVEsR0FBcUI7b0NBQ2pDLGNBQWMsRUFBRSxNQUFNO29DQUN0QixjQUFjLEVBQUUsQ0FBQztvQ0FDakIsZUFBZSxFQUFFLEtBQUs7b0NBQ3RCLGVBQWUsRUFBRSxDQUFDO29DQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLE9BQU8sQ0FBQztvQ0FDeEQsSUFBSTtvQ0FDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87b0NBQ3hCLGlCQUFpQixFQUFFLFFBQVE7b0NBQzNCLFFBQVEsRUFBRSxLQUFLO29DQUNmLFNBQVMsRUFBRSxPQUFPO29DQUNsQixTQUFTLEVBQUUsT0FBTztvQ0FDbEIscUJBQXFCLEVBQUUsSUFBSTtpQ0FDNUIsQ0FBQTtnQ0FFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO2dDQUUxQyxNQUFNLFFBQVEsR0FBaUMsTUFBTSxLQUFLLENBQUMsR0FBRyxDQUFnQixHQUFHLEdBQUcsSUFBSSxXQUFXLEVBQUUsQ0FBQyxDQUFBO2dDQUN0RyxNQUFNLEVBQ0osSUFBSSxFQUFFLEVBQUUsYUFBYSxFQUFFLHdCQUF3QixFQUFFLGdCQUFnQixFQUFFLFdBQVcsRUFBRSxFQUNoRixNQUFNLEdBQ1AsR0FBRyxRQUFRLENBQUE7Z0NBRVosTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7Z0NBRTVCLElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTtvQ0FDckIsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7aUNBQzlGO3FDQUFNO29DQUNMLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7aUNBQ2pHO2dDQUVELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTtnQ0FFNUMsTUFBTSxDQUFDLENBQUMsV0FBVyxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFBOzRCQUM1QyxDQUFDLENBQUMsQ0FBQTs0QkFFRixFQUFFLENBQUMsZ0RBQWdELEVBQUUsS0FBSyxJQUFJLEVBQUU7Z0NBQzlELE1BQU0sUUFBUSxHQUFxQjtvQ0FDakMsY0FBYyxFQUFFLE1BQU07b0NBQ3RCLGNBQWMsRUFBRSxDQUFDO29DQUNqQixlQUFlLEVBQUUsS0FBSztvQ0FDdEIsZUFBZSxFQUFFLENBQUM7b0NBQ2xCLE1BQU0sRUFBRSxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsT0FBTyxDQUFDO29DQUN4RCxJQUFJO29DQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTztvQ0FDeEIsaUJBQWlCLEVBQUUsUUFBUTtvQ0FDM0IsUUFBUSxFQUFFLEtBQUs7b0NBQ2YsU0FBUyxFQUFFLE9BQU87b0NBQ2xCLGdCQUFnQixFQUFFLElBQUk7b0NBQ3RCLFNBQVMsRUFBRSxPQUFPO29DQUNsQixxQkFBcUIsRUFBRSxJQUFJO2lDQUM1QixDQUFBO2dDQUVELE1BQU0saUJBQWlCLENBQUMsUUFBUSxFQUFFO29DQUNoQyxNQUFNLEVBQUUsR0FBRztvQ0FDWCxJQUFJLEVBQUU7d0NBQ0osTUFBTSxFQUFFLGdCQUFnQjt3Q0FDeEIsU0FBUyxFQUFFLFVBQVU7cUNBQ3RCO2lDQUNGLENBQUMsQ0FBQTs0QkFDSixDQUFDLENBQUMsQ0FBQTs0QkFFRixFQUFFLENBQUMsSUFBSSxDQUFDLGtFQUFrRSxFQUFFLEtBQUssSUFBSSxFQUFFO2dDQUNyRixNQUFNLFFBQVEsR0FBcUI7b0NBQ2pDLGNBQWMsRUFBRSxNQUFNO29DQUN0QixjQUFjLEVBQUUsQ0FBQztvQ0FDakIsZUFBZSxFQUFFLEtBQUs7b0NBQ3RCLGVBQWUsRUFBRSxDQUFDO29DQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLE9BQU8sQ0FBQztvQ0FDeEQsSUFBSTtvQ0FDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87b0NBQ3hCLGlCQUFpQixFQUFFLFFBQVE7b0NBQzNCLFFBQVEsRUFBRSxLQUFLO29DQUNmLFNBQVMsRUFBRSxPQUFPO29DQUNsQixnQkFBZ0IsRUFBRSxJQUFJO29DQUN0QixTQUFTLEVBQUUsYUFBYTtvQ0FDeEIscUJBQXFCLEVBQUUsSUFBSTtpQ0FDNUIsQ0FBQTtnQ0FFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO2dDQUUxQyxNQUFNLFFBQVEsR0FBaUMsTUFBTSxLQUFLLENBQUMsR0FBRyxDQUFnQixHQUFHLEdBQUcsSUFBSSxXQUFXLEVBQUUsQ0FBQyxDQUFBO2dDQUN0RyxNQUFNLEVBQ0osSUFBSSxFQUFFLEVBQUUsYUFBYSxFQUFFLHdCQUF3QixFQUFFLGdCQUFnQixFQUFFLFdBQVcsRUFBRSxFQUNoRixNQUFNLEdBQ1AsR0FBRyxRQUFRLENBQUE7Z0NBRVosTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7Z0NBRTVCLElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTtvQ0FDckIsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7aUNBQzlGO3FDQUFNO29DQUNMLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7aUNBQ2pHO2dDQUVELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTtnQ0FFNUMsMkVBQTJFO2dDQUMzRSxNQUFNLENBQUMsV0FBVyxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFBOzRCQUMzQyxDQUFDLENBQUMsQ0FBQTt5QkFDSDt3QkFFRCxtQ0FBbUM7d0JBQ25DLElBQUksSUFBSSxLQUFLLFNBQVMsRUFBRTs0QkFDdEIsTUFBTSxrQkFBa0IsR0FBRztnQ0FDekIsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUUsQ0FBQztnQ0FDakMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBRSxFQUFFLE1BQU0sQ0FBQzs2QkFDbEMsQ0FBQTs0QkFFRCxrQkFBa0IsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE9BQU8sRUFBRSxRQUFRLENBQUMsRUFBRSxFQUFFO2dDQUNqRCxvRUFBb0U7Z0NBQ3BFLHFHQUFxRztnQ0FDckcsMkdBQTJHO2dDQUMzRyxFQUFFLENBQUMsbUJBQW1CLE9BQU8sQ0FBQyxNQUFNLE9BQU8sUUFBUSxDQUFDLE1BQU0sRUFBRSxFQUFFLEtBQUssSUFBSSxFQUFFOztvQ0FDdkUsTUFBTSw4QkFBOEIsR0FBRyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsU0FBUyxDQUFDLENBQUE7b0NBQy9ELHVIQUF1SDtvQ0FDdkgsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFBO29DQUM5RSxNQUFNLE1BQU0sR0FBRyxNQUFNLGtCQUFrQixDQUFDLElBQUksRUFBRSxPQUFPLEVBQUUsUUFBUSxFQUFFLGNBQWMsQ0FBQyxDQUFBO29DQUVoRiwySUFBMkk7b0NBQzNJLE1BQU0sU0FBUyxHQUFHLE1BQU0sT0FBTyxDQUFDLEdBQUcsQ0FDakMsOEJBQThCLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSw4QkFBOEIsRUFBRSxFQUFFO3dDQUMxRSxJQUFJLDhCQUE4QixFQUFFOzRDQUNsQyx3R0FBd0c7NENBQ3hHLDBFQUEwRTs0Q0FDMUUsTUFBTSxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsVUFBVSxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFBO3lDQUM5Qzt3Q0FDRCxNQUFNLG1CQUFtQixHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUUsQ0FBQzs0Q0FDakUsQ0FBQyxDQUFDLDRDQUE0Qzs0Q0FDOUMsQ0FBQyxDQUFDLDRDQUE0QyxDQUFBO3dDQUNoRCxNQUFNLFFBQVEsR0FBcUI7NENBQ2pDLGNBQWMsRUFBRSxPQUFPLENBQUMsT0FBTzs0Q0FDL0IsY0FBYyxFQUFFLE9BQU8sQ0FBQyxPQUFPOzRDQUMvQixlQUFlLEVBQUUsUUFBUSxDQUFDLE9BQU87NENBQ2pDLGVBQWUsRUFBRSxRQUFRLENBQUMsT0FBTzs0Q0FDakMsTUFBTSxFQUFFLE1BQU07NENBQ2QsSUFBSSxFQUFFLElBQUk7NENBQ1YsU0FBUyxFQUFFLGFBQWE7NENBQ3hCLG1HQUFtRzs0Q0FDbkcsOEJBQThCLEVBQUUsOEJBQThCOzRDQUM5RCxTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87NENBQ3hCLG9HQUFvRzs0Q0FDcEcsbUZBQW1GOzRDQUNuRixpQkFBaUIsRUFBRSxjQUFjOzRDQUNqQyxRQUFRLEVBQUUsS0FBSzs0Q0FDZixTQUFTOzRDQUNULHFCQUFxQixFQUFFLElBQUk7NENBQzNCLG9IQUFvSDs0Q0FDcEgsbUJBQW1CLEVBQUUsOEJBQThCLENBQUMsQ0FBQyxDQUFDLG1CQUFtQixDQUFDLENBQUMsQ0FBQyxTQUFTO3lDQUN0RixDQUFBO3dDQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7d0NBRTFDLE1BQU0sUUFBUSxHQUFpQyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQzVELEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUN4QixDQUFBO3dDQUVELE9BQU8sRUFBRSw4QkFBOEIsRUFBRSxHQUFHLFFBQVEsRUFBRSxDQUFBO29DQUN4RCxDQUFDLENBQUMsQ0FDSCxDQUFBO29DQUVELE1BQU0sZUFBZSxHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyw4QkFBOEIsS0FBSyxJQUFJLENBQUMsQ0FBQTtvQ0FDeEYsTUFBTSxDQUFDLGVBQWUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTtvQ0FDM0MsU0FBUzt5Q0FDTixNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyw4QkFBOEIsS0FBSyxJQUFJLENBQUM7eUNBQ3hELE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFOzt3Q0FDYixJQUFJLElBQUksS0FBSyxTQUFTLEVBQUU7NENBQ3RCLE1BQU0sS0FBSyxHQUFHLGNBQWMsQ0FBQyxhQUFhLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUE7NENBQ2xFLE1BQU0sZUFBZSxHQUFHLGNBQWMsQ0FBQyxhQUFhLENBQUMsUUFBUSxFQUFFLGVBQWdCLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFBOzRDQUUzRixzRUFBc0U7NENBQ3RFLDBFQUEwRTs0Q0FDMUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQTs0Q0FFckQsZ0pBQWdKOzRDQUNoSixNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxDQUFBOzRDQUNsRCxNQUFNLFdBQVcsR0FBRyxVQUFVLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUE7NENBQ2xFLElBQUksT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUMsRUFBRTtnREFDM0IsTUFBTSxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxFQUFFLFNBQVMsRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQ3JFLElBQUksUUFBUSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsTUFBQSxjQUFjLENBQUMsVUFBVSxtQ0FBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLEVBQUUsRUFBRSxLQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQzNGLENBQUE7NkNBQ0Y7aURBQU0sSUFBSSxRQUFRLGFBQVIsUUFBUSx1QkFBUixRQUFRLENBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFO2dEQUNuQyxNQUFNLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEVBQUUsU0FBUyxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FDckUsSUFBSSxRQUFRLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxNQUFBLGNBQWMsQ0FBQyxTQUFTLG1DQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsRUFBRSxFQUFFLEtBQU0sQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FDMUYsQ0FBQTs2Q0FDRjt5Q0FDRjtvQ0FDSCxDQUFDLENBQUMsQ0FBQTtvQ0FFSixLQUFLLE1BQU0sUUFBUSxJQUFJLFNBQVMsRUFBRTt3Q0FDaEMsTUFBTSxFQUNKLDhCQUE4QixFQUM5QixJQUFJLEVBQUUsRUFDSixLQUFLLEVBQ0wsYUFBYSxFQUNiLHdCQUF3QixFQUN4QixnQkFBZ0IsRUFDaEIsS0FBSyxFQUNMLGdCQUFnQixFQUNoQixlQUFlLEdBQ2hCLEVBQ0QsTUFBTSxHQUNQLEdBQUcsUUFBUSxDQUFBO3dDQUVaLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBO3dDQUU1QixJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7NENBQ3JCLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsZUFBZSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBO3lDQUM5Rjs2Q0FBTTs0Q0FDTCxNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLGtCQUFrQixDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBO3lDQUNqRzt3Q0FFRCxJQUFJLFNBQVMsR0FBRyxLQUFLLENBQUE7d0NBQ3JCLElBQUksU0FBUyxHQUFHLEtBQUssQ0FBQTt3Q0FDckIsS0FBSyxNQUFNLENBQUMsSUFBSSxLQUFLLEVBQUU7NENBQ3JCLEtBQUssTUFBTSxJQUFJLElBQUksQ0FBQyxFQUFFO2dEQUNwQixJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksU0FBUyxFQUFFO29EQUMxQixTQUFTLEdBQUcsSUFBSSxDQUFBO2lEQUNqQjtnREFDRCxJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksU0FBUyxFQUFFO29EQUMxQixTQUFTLEdBQUcsSUFBSSxDQUFBO29EQUNoQixJQUFJLDhCQUE4QixFQUFFO3dEQUNsQyxJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxLQUFLLE1BQU0sQ0FBQyxPQUFPLEVBQUU7NERBQzNDLE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQTs0REFDbkQsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBQSxjQUFjLENBQUMsVUFBVSwwQ0FBRSxRQUFRLEVBQUUsQ0FBQyxDQUFBOzREQUNuRixNQUFNLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUE7NERBQ2xELE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQUEsY0FBYyxDQUFDLFNBQVMsMENBQUUsUUFBUSxFQUFFLENBQUMsQ0FBQTt5REFDbEY7d0RBQ0QsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU8sS0FBSyxNQUFNLENBQUMsT0FBTyxFQUFFOzREQUM1QyxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUE7NERBQ3BELE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQUEsY0FBYyxDQUFDLFVBQVUsMENBQUUsUUFBUSxFQUFFLENBQUMsQ0FBQTs0REFDcEYsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFBOzREQUNuRCxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFBLGNBQWMsQ0FBQyxTQUFTLDBDQUFFLFFBQVEsRUFBRSxDQUFDLENBQUE7eURBQ25GO3dEQUNELElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsT0FBTyxLQUFLLE1BQU0sQ0FBQyxPQUFPLEVBQUU7NERBQ2xELE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUE7NERBQzFELE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFBLGNBQWMsQ0FBQyxVQUFVLDBDQUFFLFFBQVEsRUFBRSxDQUFDLENBQUE7NERBQzFGLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUE7NERBQ3pELE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFBLGNBQWMsQ0FBQyxTQUFTLDBDQUFFLFFBQVEsRUFBRSxDQUFDLENBQUE7eURBQ3pGO3dEQUNELElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsT0FBTyxLQUFLLE1BQU0sQ0FBQyxPQUFPLEVBQUU7NERBQ2xELE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUE7NERBQzFELE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFBLGNBQWMsQ0FBQyxVQUFVLDBDQUFFLFFBQVEsRUFBRSxDQUFDLENBQUE7NERBQzFGLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUE7NERBQ3pELE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFBLGNBQWMsQ0FBQyxTQUFTLDBDQUFFLFFBQVEsRUFBRSxDQUFDLENBQUE7eURBQ3pGO3FEQUNGO3lEQUFNO3dEQUNMLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBO3dEQUNoRCxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3REFDL0MsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBO3dEQUN0RCxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUE7d0RBQ3JELE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3REFDdEQsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBO3FEQUN0RDtpREFDRjs2Q0FDRjt5Q0FDRjt3Q0FFRCxNQUFNLENBQUMsQ0FBQyxTQUFTLElBQUksU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUE7d0NBRTFDLElBQUksOEJBQThCLEVBQUU7NENBQ2xDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUE7NENBQzVDLE1BQU0sQ0FBQyxlQUFlLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBOzRDQUN2QyxNQUFNLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUE7NENBRTVDLGdGQUFnRjs0Q0FDaEYsa0VBQWtFOzRDQUNsRSw2R0FBNkc7NENBQzdHLE1BQU0sRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxhQUFhLEVBQUUsR0FBRyxNQUFNLFdBQVcsQ0FDdEYsUUFBUSxDQUFDLElBQUksQ0FBQyxnQkFBaUIsRUFDL0IsT0FBTyxFQUNQLFFBQVEsQ0FDVCxDQUFBOzRDQUVELE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxjQUFjLENBQUMsQ0FBQTs0Q0FDL0UsZUFBZSxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQTt5Q0FDOUY7cUNBQ0Y7Z0NBQ0gsQ0FBQyxDQUFDLENBQUE7NEJBQ0osQ0FBQyxDQUFDLENBQUE7eUJBQ0g7cUJBQ0Y7Z0JBQ0gsQ0FBQyxDQUFDLENBQUE7Z0JBRUYsSUFBSSxTQUFTLElBQUksT0FBTyxFQUFFO29CQUN4QixRQUFRLENBQUMsZ0NBQWdDLEVBQUUsR0FBRyxFQUFFO3dCQUM5QyxFQUFFLENBQUMsZ0JBQWdCLEVBQUUsS0FBSyxJQUFJLEVBQUU7NEJBQzlCLE1BQU0sUUFBUSxHQUFxQjtnQ0FDakMsY0FBYyxFQUFFLE1BQU07Z0NBQ3RCLGNBQWMsRUFBRSxDQUFDO2dDQUNqQixlQUFlLEVBQUUsTUFBTTtnQ0FDdkIsZUFBZSxFQUFFLENBQUM7Z0NBQ2xCLE1BQU0sRUFBRSxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDO2dDQUN2RCxJQUFJO2dDQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTztnQ0FDeEIsaUJBQWlCLEVBQUUsUUFBUTtnQ0FDM0IsUUFBUSxFQUFFLEtBQUs7Z0NBQ2YsU0FBUztnQ0FDVCxtQkFBbUIsRUFBRSw0Q0FBNEM7Z0NBQ2pFLHFCQUFxQixFQUFFLElBQUk7NkJBQzVCLENBQUE7NEJBRUQsTUFBTSxXQUFXLEdBQUcsRUFBRSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQTs0QkFFMUMsTUFBTSxRQUFRLEdBQWlDLE1BQU0sS0FBSyxDQUFDLEdBQUcsQ0FBZ0IsR0FBRyxHQUFHLElBQUksV0FBVyxFQUFFLENBQUMsQ0FBQTs0QkFDdEcsTUFBTSxFQUNKLElBQUksRUFBRSxFQUFFLEtBQUssRUFBRSxhQUFhLEVBQUUsd0JBQXdCLEVBQUUsZ0JBQWdCLEVBQUUsZUFBZSxFQUFFLEVBQzNGLE1BQU0sR0FDUCxHQUFHLFFBQVEsQ0FBQTs0QkFFWixNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTs0QkFDNUIsTUFBTSxDQUFDLGVBQWUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUE7NEJBQ3ZDLE1BQU0sQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUMsQ0FBQTs0QkFDdkQsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFBOzRCQUVyRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7Z0NBQ3JCLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsZUFBZSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBOzZCQUM5RjtpQ0FBTTtnQ0FDTCxNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLGtCQUFrQixDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBOzZCQUNqRzs0QkFFRCxNQUFNLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUE7NEJBRTVDLE1BQU0sRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxhQUFhLEVBQUUsR0FBRyxNQUFNLFdBQVcsQ0FDdEYsZ0JBQWlCLEVBQ2pCLFlBQVksRUFDWixZQUFZLENBQ2IsQ0FBQTs0QkFFRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7Z0NBQ3JCLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQTtnQ0FDdEUsZUFBZSxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQTs2QkFDbEc7aUNBQU07Z0NBQ0wsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO2dDQUN4RSxlQUFlLENBQUMsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFlBQVksRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFBOzZCQUNoRzt3QkFDSCxDQUFDLENBQUMsQ0FBQTt3QkFFRixFQUFFLENBQUMsNkJBQTZCLEVBQUUsS0FBSyxJQUFJLEVBQUU7NEJBQzNDLE1BQU0sUUFBUSxHQUFxQjtnQ0FDakMsY0FBYyxFQUFFLE1BQU07Z0NBQ3RCLGNBQWMsRUFBRSxDQUFDO2dDQUNqQixlQUFlLEVBQUUsTUFBTTtnQ0FDdkIsZUFBZSxFQUFFLENBQUM7Z0NBQ2xCLE1BQU0sRUFBRSxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDO2dDQUN2RCxJQUFJO2dDQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTztnQ0FDeEIsaUJBQWlCLEVBQUUsUUFBUTtnQ0FDM0IsUUFBUSxFQUFFLEtBQUs7Z0NBQ2YsU0FBUztnQ0FDVCxtQkFBbUIsRUFBRSw0Q0FBNEM7NkJBQ2xFLENBQUE7NEJBRUQsTUFBTSxXQUFXLEdBQUcsRUFBRSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQTs0QkFFMUMsTUFBTSxRQUFRLEdBQWlDLE1BQU0sS0FBSyxDQUFDLEdBQUcsQ0FBZ0IsR0FBRyxHQUFHLElBQUksV0FBVyxFQUFFLENBQUMsQ0FBQTs0QkFDdEcsTUFBTSxFQUNKLElBQUksRUFBRSxFQUFFLEtBQUssRUFBRSxhQUFhLEVBQUUsd0JBQXdCLEVBQUUsZ0JBQWdCLEVBQUUsZUFBZSxFQUFFLEVBQzNGLE1BQU0sR0FDUCxHQUFHLFFBQVEsQ0FBQTs0QkFFWixNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTs0QkFDNUIsTUFBTSxDQUFDLGVBQWUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUE7NEJBQ3ZDLE1BQU0sQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUMsQ0FBQTs0QkFDdkQsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFBOzRCQUVyRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7Z0NBQ3JCLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsZUFBZSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBOzZCQUM5RjtpQ0FBTTtnQ0FDTCxNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLGtCQUFrQixDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBOzZCQUNqRzs0QkFFRCxNQUFNLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUE7NEJBQzVDLE1BQU0sQ0FBQyxnQkFBaUIsQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFBOzRCQUVoRixNQUFNLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFLEdBQUcsTUFBTSxXQUFXLENBQ3RGLGdCQUFpQixFQUNqQixZQUFZLEVBQ1osWUFBWSxDQUNiLENBQUE7NEJBRUQsSUFBSSxJQUFJLElBQUksU0FBUyxFQUFFO2dDQUNyQixNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUE7Z0NBQ3RFLGVBQWUsQ0FBQyxjQUFjLEVBQUUsYUFBYSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsWUFBWSxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUE7NkJBQ2xHO2lDQUFNO2dDQUNMLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQTtnQ0FDeEUsZUFBZSxDQUFDLGFBQWEsRUFBRSxZQUFZLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQTs2QkFDaEc7d0JBQ0gsQ0FBQyxDQUFDLENBQUE7d0JBRUYsSUFBSSx3QkFBd0IsRUFBRSxFQUFFOzRCQUM5QixFQUFFLENBQUMsMkNBQTJDLEVBQUUsS0FBSyxJQUFJLEVBQUU7Z0NBQ3pELHlEQUF5RDtnQ0FDekQsc0JBQXNCO2dDQUN0QixNQUFNLE1BQU0sR0FBRyxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsSUFBSSxDQUFDLENBQUE7Z0NBRTdELE1BQU0sS0FBSyxHQUFHLEdBQUcsQ0FBQTtnQ0FFakIsTUFBTSxNQUFNLEdBQWlCO29DQUMzQixPQUFPLEVBQUU7d0NBQ1AsS0FBSyxFQUFFLFlBQVksQ0FBQyxPQUFPO3dDQUMzQixNQUFNLEVBQUUsTUFBTTt3Q0FDZCxVQUFVLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDLE9BQU8sRUFBRSxHQUFHLElBQUksR0FBRyxRQUFRLENBQUMsQ0FBQyxRQUFRLEVBQUU7d0NBQ3pFLEtBQUs7cUNBQ047b0NBQ0QsT0FBTyxFQUFFLHdCQUF3QjtvQ0FDakMsV0FBVyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQyxPQUFPLEVBQUUsR0FBRyxJQUFJLEdBQUcsUUFBUSxDQUFDLENBQUMsUUFBUSxFQUFFO2lDQUMzRSxDQUFBO2dDQUVELE1BQU0sTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsU0FBVSxDQUFDLENBQUE7Z0NBRWpELE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxHQUFHLGlCQUFpQixDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUUsZUFBZSxFQUFFLENBQUMsQ0FBQyxDQUFBO2dDQUU3RixNQUFNLFNBQVMsR0FBRyxNQUFNLE1BQU0sQ0FBQyxjQUFjLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxNQUFNLENBQUMsQ0FBQTtnQ0FFcEUsTUFBTSxRQUFRLEdBQXFCO29DQUNqQyxjQUFjLEVBQUUsTUFBTTtvQ0FDdEIsY0FBYyxFQUFFLENBQUM7b0NBQ2pCLGVBQWUsRUFBRSxNQUFNO29DQUN2QixlQUFlLEVBQUUsQ0FBQztvQ0FDbEIsTUFBTTtvQ0FDTixJQUFJO29DQUNKLFNBQVMsRUFBRSxNQUFNLENBQUMsT0FBTztvQ0FDekIsaUJBQWlCLEVBQUUsUUFBUTtvQ0FDM0IsUUFBUSxFQUFFLEtBQUs7b0NBQ2YsU0FBUztvQ0FDVCxtQkFBbUIsRUFBRSxNQUFNLENBQUMsT0FBTztvQ0FDbkMsZUFBZSxFQUFFLFNBQVM7b0NBQzFCLFlBQVksRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxRQUFRLEVBQUU7b0NBQzlDLGdCQUFnQixFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDLFFBQVEsRUFBRTtvQ0FDdEQsaUJBQWlCLEVBQUUsTUFBTSxDQUFDLFdBQVcsQ0FBQyxRQUFRLEVBQUU7b0NBQ2hELFdBQVcsRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUU7b0NBQzVDLHFCQUFxQixFQUFFLElBQUk7aUNBQzVCLENBQUE7Z0NBRUQsTUFBTSxXQUFXLEdBQUcsRUFBRSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQTtnQ0FFMUMsTUFBTSxRQUFRLEdBQWlDLE1BQU0sS0FBSyxDQUFDLEdBQUcsQ0FBZ0IsR0FBRyxHQUFHLElBQUksV0FBVyxFQUFFLENBQUMsQ0FBQTtnQ0FDdEcsTUFBTSxFQUNKLElBQUksRUFBRSxFQUFFLGFBQWEsRUFBRSx3QkFBd0IsRUFBRSxnQkFBZ0IsRUFBRSxlQUFlLEVBQUUsRUFDcEYsTUFBTSxHQUNQLEdBQUcsUUFBUSxDQUFBO2dDQUNaLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBO2dDQUU1QixNQUFNLENBQUMsZUFBZSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQTtnQ0FFdkMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFBO2dDQUN0RCxNQUFNLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUE7Z0NBRXBELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTtvQ0FDckIsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7aUNBQzlGO3FDQUFNO29DQUNMLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7aUNBQ2pHO2dDQUVELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTs0QkFDOUMsQ0FBQyxDQUFDLENBQUE7eUJBQ0g7d0JBRUQsRUFBRSxDQUFDLGNBQWMsRUFBRSxLQUFLLElBQUksRUFBRTs0QkFDNUIsTUFBTSxRQUFRLEdBQXFCO2dDQUNqQyxjQUFjLEVBQUUsTUFBTTtnQ0FDdEIsY0FBYyxFQUFFLENBQUM7Z0NBQ2pCLGVBQWUsRUFBRSxLQUFLO2dDQUN0QixlQUFlLEVBQUUsQ0FBQztnQ0FDbEIsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxJQUFJLElBQUksU0FBUyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztnQ0FDckYsSUFBSTtnQ0FDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87Z0NBQ3hCLGlCQUFpQixFQUFFLFFBQVE7Z0NBQzNCLFFBQVEsRUFBRSxLQUFLO2dDQUNmLFNBQVM7Z0NBQ1QsbUJBQW1CLEVBQUUsNENBQTRDO2dDQUNqRSxxQkFBcUIsRUFBRSxJQUFJOzZCQUM1QixDQUFBOzRCQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7NEJBRTFDLE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUFDLEdBQUcsQ0FBZ0IsR0FBRyxHQUFHLElBQUksV0FBVyxFQUFFLENBQUMsQ0FBQTs0QkFDeEUsTUFBTSxFQUNKLElBQUksRUFBRSxFQUFFLEtBQUssRUFBRSxnQkFBZ0IsRUFBRSxlQUFlLEVBQUUsRUFDbEQsTUFBTSxHQUNQLEdBQUcsUUFBUSxDQUFBOzRCQUVaLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBOzRCQUM1QixNQUFNLENBQUMsZUFBZSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQTs0QkFDdkMsTUFBTSxDQUFDLGdCQUFnQixDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBOzRCQUU1QyxNQUFNLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFLEdBQUcsTUFBTSxXQUFXLENBQ3RGLGdCQUFpQixFQUNqQixZQUFZLEVBQ1osS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FDakIsQ0FBQTs0QkFFRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7Z0NBQ3JCLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQTtnQ0FDMUUsZUFBZSxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUE7NkJBQ3RHO2lDQUFNO2dDQUNMLDhGQUE4RjtnQ0FDOUYsZUFBZSxDQUFDLGFBQWEsRUFBRSxZQUFZLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQTs2QkFDaEc7d0JBQ0gsQ0FBQyxDQUFDLENBQUE7d0JBRUYsRUFBRSxDQUFDLDBCQUEwQixFQUFFLEtBQUssSUFBSSxFQUFFOzRCQUN4QyxzREFBc0Q7NEJBQ3RELE1BQU0sUUFBUSxHQUFxQjtnQ0FDakMsY0FBYyxFQUFFLE1BQU07Z0NBQ3RCLGNBQWMsRUFBRSxDQUFDO2dDQUNqQixlQUFlLEVBQUUsS0FBSztnQ0FDdEIsZUFBZSxFQUFFLENBQUM7Z0NBQ2xCLE1BQU0sRUFDSixJQUFJLElBQUksU0FBUztvQ0FDZixDQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLFNBQVMsQ0FBQztvQ0FDcEQsQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUM7Z0NBQ3BELElBQUk7Z0NBQ0osU0FBUyxFQUFFLEtBQUssQ0FBQyxPQUFPO2dDQUN4QixpQkFBaUIsRUFBRSxRQUFRO2dDQUMzQixRQUFRLEVBQUUsS0FBSztnQ0FDZixTQUFTO2dDQUNULG1CQUFtQixFQUFFLDRDQUE0QztnQ0FDakUscUJBQXFCLEVBQUUsSUFBSTs2QkFDNUIsQ0FBQTs0QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBOzRCQUUxQyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7NEJBQ3hFLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFBOzRCQUVqQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTs0QkFDNUIsTUFBTSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBOzRCQUM1QyxNQUFNLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBOzRCQUVqRCxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTs0QkFFdEMsTUFBTSxrQkFBa0IsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQztpQ0FDckMsT0FBTyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFFLENBQUM7aUNBQzdCLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7aUNBQ2pDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7aUNBQzVDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBOzRCQUM1RCxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQTs0QkFDM0MsTUFBTSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsQ0FBQyxDQUFBOzRCQUV2QyxNQUFNLG1CQUFtQixHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDO2lDQUN0QyxPQUFPLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUUsQ0FBQztpQ0FDN0IsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQztpQ0FDbEMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztpQ0FDN0MsTUFBTSxDQUFDLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUE7NEJBQzVELE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFBOzRCQUM1QyxNQUFNLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDLENBQUE7NEJBRXpDLE1BQU0sRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxhQUFhLEVBQUUsR0FBRyxNQUFNLFdBQVcsQ0FDdEYsSUFBSSxDQUFDLGdCQUFpQixFQUN0QixZQUFZLEVBQ1osS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FDakIsQ0FBQTs0QkFFRCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7Z0NBQ3JCLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQTtnQ0FDMUUsZUFBZSxDQUNiLGNBQWMsRUFDZCxhQUFhLEVBQ2IsY0FBYyxDQUFDLGFBQWEsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FDM0QsQ0FBQTs2QkFDRjtpQ0FBTTtnQ0FDTCw4RkFBOEY7Z0NBQzlGLGVBQWUsQ0FBQyxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsWUFBWSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFBOzZCQUNyRzt3QkFDSCxDQUFDLENBQUMsQ0FBQTt3QkFFRixFQUFFLENBQUMsY0FBYyxFQUFFLEtBQUssSUFBSSxFQUFFOzRCQUM1QixNQUFNLFFBQVEsR0FBcUI7Z0NBQ2pDLGNBQWMsRUFBRSxLQUFLO2dDQUNyQixjQUFjLEVBQUUsQ0FBQztnQ0FDakIsZUFBZSxFQUFFLEtBQUs7Z0NBQ3RCLGVBQWUsRUFBRSxDQUFDO2dDQUNsQixNQUFNLEVBQ0osSUFBSSxJQUFJLFNBQVM7b0NBQ2YsQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUM7b0NBQzlDLENBQUMsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsT0FBTyxDQUFDO2dDQUNyRCxJQUFJO2dDQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTztnQ0FDeEIsaUJBQWlCLEVBQUUsSUFBSSxJQUFJLFVBQVUsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxRQUFRO2dDQUNqRSxRQUFRLEVBQUUsS0FBSztnQ0FDZixTQUFTO2dDQUNULG1CQUFtQixFQUFFLDRDQUE0QztnQ0FDakUscUJBQXFCLEVBQUUsSUFBSTs2QkFDNUIsQ0FBQTs0QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBOzRCQUUxQyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7NEJBQ3hFLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFBOzRCQUNqQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTs0QkFDNUIsTUFBTSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBOzRCQUM1QyxNQUFNLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBOzRCQUVqRCxNQUFNLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFLEdBQUcsTUFBTSxXQUFXLENBQ3RGLElBQUksQ0FBQyxnQkFBaUIsRUFDdEIsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFDaEIsV0FBVyxDQUNaLENBQUE7NEJBRUQsSUFBSSxJQUFJLElBQUksU0FBUyxFQUFFO2dDQUNyQixtQ0FBbUM7Z0NBQ25DLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUE7Z0NBQ3hHLGVBQWUsQ0FBQyxjQUFjLEVBQUUsYUFBYSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsV0FBVyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFBOzZCQUN0RztpQ0FBTTtnQ0FDTCxNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUE7Z0NBQzFFLDhFQUE4RTs2QkFDL0U7d0JBQ0gsQ0FBQyxDQUFDLENBQUE7d0JBRUYsRUFBRSxDQUFDLDJCQUEyQixFQUFFLEtBQUssSUFBSSxFQUFFOzRCQUN6QyxNQUFNLFFBQVEsR0FBcUI7Z0NBQ2pDLGNBQWMsRUFBRSxLQUFLO2dDQUNyQixjQUFjLEVBQUUsQ0FBQztnQ0FDakIsZUFBZSxFQUFFLEtBQUs7Z0NBQ3RCLGVBQWUsRUFBRSxDQUFDO2dDQUNsQixNQUFNLEVBQ0osSUFBSSxJQUFJLFNBQVM7b0NBQ2YsQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUM7b0NBQzlDLENBQUMsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsT0FBTyxDQUFDO2dDQUNyRCxJQUFJO2dDQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTztnQ0FDeEIsaUJBQWlCLEVBQUUsSUFBSSxJQUFJLFVBQVUsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxRQUFRO2dDQUNqRSxRQUFRLEVBQUUsS0FBSztnQ0FDZixTQUFTO2dDQUNULG1CQUFtQixFQUFFLDRDQUE0QztnQ0FDakUscUJBQXFCLEVBQUUsS0FBSzs2QkFDN0IsQ0FBQTs0QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBOzRCQUUxQyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7NEJBQ3hFLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFBOzRCQUNqQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTs0QkFDNUIsTUFBTSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTs0QkFFakQsTUFBTSxFQUFFLGFBQWEsRUFBRSxZQUFZLEVBQUUsY0FBYyxFQUFFLGFBQWEsRUFBRSxHQUFHLE1BQU0sV0FBVyxDQUN0RixJQUFJLENBQUMsZ0JBQWlCLEVBQ3RCLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQ2hCLFdBQVcsQ0FDWixDQUFBOzRCQUVELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTtnQ0FDckIsbUNBQW1DO2dDQUNuQyxNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsQ0FBQyxXQUFXLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFBO2dDQUN4RyxlQUFlLENBQUMsY0FBYyxFQUFFLGFBQWEsRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFdBQVcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQTtnQ0FDckcsTUFBTSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBOzZCQUM3QztpQ0FBTTtnQ0FDTCxNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUE7Z0NBQzFFLDhFQUE4RTs2QkFDL0U7d0JBQ0gsQ0FBQyxDQUFDLENBQUE7d0JBRUYsRUFBRSxDQUFDLGVBQWUsRUFBRSxLQUFLLElBQUksRUFBRTs0QkFDN0IsTUFBTSxRQUFRLEdBQXFCO2dDQUNqQyxjQUFjLEVBQUUsTUFBTTtnQ0FDdEIsY0FBYyxFQUFFLENBQUM7Z0NBQ2pCLGVBQWUsRUFBRSxLQUFLO2dDQUN0QixlQUFlLEVBQUUsQ0FBQztnQ0FDbEIsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUM7Z0NBQ3RELElBQUk7Z0NBQ0osU0FBUyxFQUFFLEtBQUssQ0FBQyxPQUFPO2dDQUN4QixpQkFBaUIsRUFBRSxRQUFRO2dDQUMzQixRQUFRLEVBQUUsS0FBSztnQ0FDZixTQUFTO2dDQUNULG1CQUFtQixFQUFFLDRDQUE0QztnQ0FDakUscUJBQXFCLEVBQUUsSUFBSTs2QkFDNUIsQ0FBQTs0QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBOzRCQUUxQyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7NEJBQ3hFLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFBOzRCQUNqQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTs0QkFDNUIsTUFBTSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBOzRCQUM1QyxNQUFNLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBOzRCQUVqRCxNQUFNLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFLEdBQUcsTUFBTSxXQUFXLENBQ3RGLElBQUksQ0FBQyxnQkFBaUIsRUFDdEIsS0FBSyxDQUFDLENBQUMsQ0FBRSxFQUNULFdBQVcsQ0FDWixDQUFBOzRCQUVELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTtnQ0FDckIsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO2dDQUN0RSxlQUFlLENBQUMsY0FBYyxFQUFFLGFBQWEsRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFdBQVcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQTs2QkFDdEc7aUNBQU07Z0NBQ0wsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO2dDQUN4RSxlQUFlLENBQUMsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUUsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQTs2QkFDbEc7d0JBQ0gsQ0FBQyxDQUFDLENBQUE7d0JBRUYsRUFBRSxDQUFDLGVBQWUsRUFBRSxLQUFLLElBQUksRUFBRTs0QkFDN0IsTUFBTSxRQUFRLEdBQXFCO2dDQUNqQyxjQUFjLEVBQUUsTUFBTTtnQ0FDdEIsY0FBYyxFQUFFLENBQUM7Z0NBQ2pCLGVBQWUsRUFBRSxNQUFNO2dDQUN2QixlQUFlLEVBQUUsQ0FBQztnQ0FDbEIsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUM7Z0NBQ3ZELElBQUk7Z0NBQ0osU0FBUyxFQUFFLEtBQUssQ0FBQyxPQUFPO2dDQUN4QixpQkFBaUIsRUFBRSxRQUFRO2dDQUMzQixRQUFRLEVBQUUsS0FBSztnQ0FDZixTQUFTO2dDQUNULG1CQUFtQixFQUFFLDRDQUE0QztnQ0FDakUscUJBQXFCLEVBQUUsSUFBSTs2QkFDNUIsQ0FBQTs0QkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBOzRCQUUxQyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7NEJBQ3hFLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFBOzRCQUNqQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTs0QkFDNUIsTUFBTSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBOzRCQUM1QyxNQUFNLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBOzRCQUVqRCxNQUFNLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFLEdBQUcsTUFBTSxXQUFXLENBQ3RGLElBQUksQ0FBQyxnQkFBaUIsRUFDdEIsWUFBWSxFQUNaLEtBQUssQ0FBQyxDQUFDLENBQUUsQ0FDVixDQUFBOzRCQUVELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTtnQ0FDckIsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO2dDQUN0RSxlQUFlLENBQUMsY0FBYyxFQUFFLGFBQWEsRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQTs2QkFDbkc7aUNBQU07Z0NBQ0wsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO2dDQUN4RSxlQUFlLENBQUMsYUFBYSxFQUFFLFlBQVksRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFlBQVksRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQTs2QkFDckc7d0JBQ0gsQ0FBQyxDQUFDLENBQUE7d0JBRUYsTUFBTSx1QkFBdUIsR0FBRyxDQUFDLFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQTt3QkFDbkQscUJBQXFCLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxPQUFPLEVBQUUsUUFBUSxDQUFDLEVBQUUsRUFBRTs0QkFDcEQsdUJBQXVCLENBQUMsT0FBTyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7Z0NBQ3hDLEVBQUUsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxNQUFNLE9BQU8sUUFBUSxDQUFDLE1BQU0sMEJBQTBCLEtBQUssRUFBRSxFQUFFLEtBQUssSUFBSSxFQUFFO29DQUN0RixNQUFNLGNBQWMsR0FBRyxJQUFJLENBQUE7b0NBQzNCLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxNQUFPLENBQUE7b0NBQ3JDLE1BQU0sY0FBYyxHQUFHLFFBQVEsQ0FBQyxNQUFPLENBQUE7b0NBQ3ZDLE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQTtvQ0FDekUsTUFBTSxlQUFlLEdBQUcsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFBO29DQUM3RSxNQUFNLE1BQU0sR0FBRyxNQUFNLGtCQUFrQixDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsT0FBTyxFQUFFLFFBQVEsQ0FBQyxPQUFPLEVBQUUsY0FBYyxDQUFDLENBQUE7b0NBRWhHLDBIQUEwSDtvQ0FDMUgsd0RBQXdEO29DQUN4RCxJQUFJLFdBQVcsR0FBRyxTQUFTLENBQUE7b0NBQzNCLElBQUksS0FBSyxLQUFLLFFBQVEsSUFBSSxJQUFJLEtBQUssU0FBUyxFQUFFO3dDQUM1QyxXQUFXLEdBQUcsWUFBWSxDQUFDLElBQUksQ0FBQTtxQ0FDaEM7eUNBQU0sSUFBSSxLQUFLLEtBQUssT0FBTyxFQUFFO3dDQUM1QixXQUFXLEdBQUcsWUFBWSxDQUFDLElBQUksQ0FBQTtxQ0FDaEM7b0NBQ0QsSUFBSSxhQUFhLEdBQUcsU0FBUyxDQUFBO29DQUM3QixJQUFJLEtBQUssS0FBSyxRQUFRLElBQUksSUFBSSxLQUFLLFVBQVUsRUFBRTt3Q0FDN0MsYUFBYSxHQUFHLGNBQWMsQ0FBQyxhQUFhLENBQUMsUUFBUSxFQUFFLE1BQU0sQ0FBQzs2Q0FDM0QsUUFBUSxDQUFDLElBQUksUUFBUSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsS0FBTSxDQUFDLENBQUM7NkNBQ2pELFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FBQTtxQ0FDdkI7eUNBQU0sSUFBSSxLQUFLLEtBQUssT0FBTyxFQUFFO3dDQUM1Qiw0RUFBNEU7d0NBQzVFLG1DQUFtQzt3Q0FDbkMsYUFBYSxHQUFHLFNBQVMsQ0FBQTtxQ0FDMUI7b0NBRUQsTUFBTSxRQUFRLEdBQXFCO3dDQUNqQyxjQUFjLEVBQUUsY0FBYzt3Q0FDOUIsY0FBYyxFQUFFLE9BQU8sQ0FBQyxPQUFPO3dDQUMvQixlQUFlLEVBQUUsZUFBZTt3Q0FDaEMsZUFBZSxFQUFFLFFBQVEsQ0FBQyxPQUFPO3dDQUNqQyxNQUFNLEVBQUUsTUFBTTt3Q0FDZCxJQUFJLEVBQUUsSUFBSTt3Q0FDVixTQUFTLEVBQUUsYUFBYTt3Q0FDeEIsU0FBUyxFQUFFLEtBQUssQ0FBQyxPQUFPO3dDQUN4QixpQkFBaUIsRUFBRSxRQUFRO3dDQUMzQixRQUFRLEVBQUUsS0FBSzt3Q0FDZixTQUFTO3dDQUNULHFCQUFxQixFQUFFLElBQUk7d0NBQzNCLG1CQUFtQixFQUFFLEtBQUssQ0FBQyxPQUFPO3dDQUNsQyxXQUFXLEVBQUUsV0FBVzt3Q0FDeEIsYUFBYSxFQUFFLGFBQWE7d0NBQzVCLGdCQUFnQixFQUFFLFlBQVksQ0FBQyxTQUFTO3FDQUN6QyxDQUFBO29DQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7b0NBRTFDLE1BQU0sUUFBUSxHQUFpQyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7b0NBQ3RHLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFBO29DQUNqQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTtvQ0FDNUIsTUFBTSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO29DQUM1QyxNQUFNLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBO29DQUVqRCxNQUFNLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBO29DQUVqRCxJQUFJLENBQUMsQ0FBQyxLQUFLLEtBQUssUUFBUSxJQUFJLElBQUksS0FBSyxVQUFVLENBQUMsRUFBRTt3Q0FDaEQsc0VBQXNFO3dDQUN0RSxvREFBb0Q7d0NBQ3BELE1BQU0sQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBO3dDQUM1QyxNQUFNLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFBO3FDQUNyRDtvQ0FDRCxNQUFNLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTtvQ0FDOUMsTUFBTSxDQUFDLElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTtvQ0FDdEQsTUFBTSxDQUFDLElBQUksQ0FBQywwQkFBMEIsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTtvQ0FDM0QsTUFBTSxDQUFDLElBQUksQ0FBQyxrQ0FBa0MsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTtvQ0FFbkUsTUFBTSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxDQUFBO29DQUU5RCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7d0NBQ3JCLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxDQUFDLEtBQUs7NkNBQ3JDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQ2QsTUFBTTs2Q0FDSCxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUM7NkNBQy9CLEdBQUcsQ0FBQyxDQUFDLFNBQVMsRUFBRSxFQUFFLENBQUMsY0FBYyxDQUFDLGFBQWEsQ0FBQyxRQUFRLEVBQUUsU0FBUyxhQUFULFNBQVMsY0FBVCxTQUFTLEdBQUksR0FBRyxDQUFDLENBQUM7NkNBQzVFLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsY0FBYyxDQUFDLGFBQWEsQ0FBQyxRQUFRLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FDdkY7NkNBQ0EsTUFBTSxDQUFDLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFBO3dDQUV0RixNQUFNLEtBQUssR0FBRyxjQUFjLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUE7d0NBQ2hFLE1BQU0scUJBQXFCLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJLFFBQVEsQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUE7d0NBQ3BGLE1BQU0sQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQTt3Q0FFOUUscUdBQXFHO3dDQUNyRyxvR0FBb0c7d0NBQ3BHLE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxRQUFRLENBQUMscUJBQXFCLENBQUMsQ0FBQTt3Q0FDeEQsTUFBTSxXQUFXLEdBQUcsVUFBVSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFBO3dDQUNsRSxNQUFNLENBQUMsV0FBVyxDQUFDLFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FDM0MsSUFBSSxRQUFRLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSxLQUFNLENBQUMsQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLENBQzVELENBQUE7cUNBQ0Y7eUNBQU07d0NBQ0wsTUFBTSxxQkFBcUIsR0FBRyxJQUFJLENBQUMsS0FBSzs2Q0FDckMsR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FDZCxNQUFNOzZDQUNILEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQzs2Q0FDL0IsR0FBRyxDQUFDLENBQUMsU0FBUyxFQUFFLEVBQUUsQ0FBQyxjQUFjLENBQUMsYUFBYSxDQUFDLE9BQU8sRUFBRSxTQUFTLGFBQVQsU0FBUyxjQUFULFNBQVMsR0FBSSxHQUFHLENBQUMsQ0FBQzs2Q0FDM0UsTUFBTSxDQUFDLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLE9BQU8sRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUN0Rjs2Q0FDQSxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsT0FBTyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUE7d0NBQ3JGLE1BQU0sS0FBSyxHQUFHLGNBQWMsQ0FBQyxhQUFhLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQTt3Q0FDL0QsTUFBTSxxQkFBcUIsR0FBRyxjQUFjLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUMsQ0FBQyxRQUFRLENBQ25GLElBQUksUUFBUSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQ3ZDLENBQUE7d0NBQ0QsTUFBTSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLHFCQUFxQixDQUFDLFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFBO3dDQUU5RSxxR0FBcUc7d0NBQ3JHLG9HQUFvRzt3Q0FDcEcsTUFBTSxVQUFVLEdBQUcscUJBQXFCLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFBO3dDQUN4RCxNQUFNLFdBQVcsR0FBRyxVQUFVLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUE7d0NBQ2xFLE1BQU0sQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUMsS0FBSyxDQUMzQyxJQUFJLFFBQVEsQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLEtBQU0sQ0FBQyxDQUFDLFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FDNUQsQ0FBQTtxQ0FDRjtvQ0FFRCxNQUFNLEVBQ0osYUFBYSxFQUNiLFlBQVksRUFDWixjQUFjLEVBQ2QsYUFBYSxFQUNiLDhCQUE4QixFQUM5Qiw2QkFBNkIsR0FDOUIsR0FBRyxNQUFNLFdBQVcsQ0FDbkIsSUFBSSxDQUFDLGdCQUFpQixFQUN0QixPQUFPLEVBQ1AsUUFBUyxFQUNULEtBQUssRUFDTCxPQUFPLENBQUMsT0FBTyxFQUNmLFlBQVksQ0FDYixDQUFBO29DQUVELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTt3Q0FDckIsNkpBQTZKO3dDQUM3SixJQUFJLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRTs0Q0FDckIsTUFBTSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLGNBQWMsQ0FBQyxDQUFBO3lDQUNoRjt3Q0FFRCw4SkFBOEo7d0NBQzlKLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFOzRDQUN0QixlQUFlLENBQUMsY0FBYyxFQUFFLGFBQWEsRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQTt5Q0FDbkc7d0NBRUQsTUFBTSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUE7d0NBRTlDLE1BQU0scUJBQXFCLEdBQUcsY0FBYyxDQUFDLGFBQWEsQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLGFBQWMsQ0FBQyxDQUFBO3dDQUN6RiwwQkFBMEIsQ0FDeEIsOEJBQStCLEVBQy9CLDZCQUE4QixFQUM5QixxQkFBcUIsQ0FDdEIsQ0FBQTtxQ0FDRjt5Q0FBTTt3Q0FDTCw4SkFBOEo7d0NBQzlKLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFOzRDQUN0QixNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLENBQUE7eUNBQ2xGO3dDQUVELDhKQUE4Sjt3Q0FDOUosSUFBSSxDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUU7NENBQ3JCLGVBQWUsQ0FBQyxhQUFhLEVBQUUsWUFBWSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFBO3lDQUNoRzt3Q0FFRCxNQUFNLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTt3Q0FFOUMsTUFBTSxxQkFBcUIsR0FBRyxjQUFjLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsYUFBYyxDQUFDLENBQUE7d0NBQ3pGLDBCQUEwQixDQUN4Qiw4QkFBK0IsRUFDL0IsNkJBQThCLEVBQzlCLHFCQUFxQixDQUN0QixDQUFBO3FDQUNGO2dDQUNILENBQUMsQ0FBQyxDQUFBOzRCQUNKLENBQUMsQ0FBQyxDQUFBO3dCQUNKLENBQUMsQ0FBQyxDQUFBO29CQUNKLENBQUMsQ0FBQyxDQUFBO2lCQUNIO2dCQUNELEVBQUUsQ0FBQywrQ0FBK0MsRUFBRSxLQUFLLElBQUksRUFBRTtvQkFDN0QsTUFBTSxRQUFRLEdBQXFCO3dCQUNqQyxjQUFjLEVBQUUsTUFBTTt3QkFDdEIsY0FBYyxFQUFFLENBQUM7d0JBQ2pCLGVBQWUsRUFBRSxNQUFNO3dCQUN2QixlQUFlLEVBQUUsQ0FBQzt3QkFDbEIsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUM7d0JBQ3ZELElBQUk7d0JBQ0osU0FBUzt3QkFDVCxxQkFBcUIsRUFBRSxJQUFJO3FCQUM1QixDQUFBO29CQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7b0JBRTFDLE1BQU0sUUFBUSxHQUFpQyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7b0JBQ3RHLE1BQU0sRUFDSixJQUFJLEVBQUUsRUFBRSxhQUFhLEVBQUUsd0JBQXdCLEVBQUUsZ0JBQWdCLEVBQUUsRUFDbkUsTUFBTSxHQUNQLEdBQUcsUUFBUSxDQUFBO29CQUVaLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBO29CQUM1QixNQUFNLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsRUFBRSxDQUFDLENBQUE7b0JBQ3ZELE1BQU0sQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQTtvQkFFckQsSUFBSSxJQUFJLElBQUksU0FBUyxFQUFFO3dCQUNyQixNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLGVBQWUsQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQTtxQkFDOUY7eUJBQU07d0JBQ0wsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQTtxQkFDakc7b0JBRUQsTUFBTSxDQUFDLGdCQUFnQixDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUE7Z0JBQzFDLENBQUMsQ0FBQyxDQUFBO2dCQUVGLEVBQUUsQ0FBQywrQ0FBK0MsRUFBRSxLQUFLLElBQUksRUFBRTtvQkFDN0QsTUFBTSxRQUFRLEdBQXFCO3dCQUNqQyxjQUFjLEVBQUUsTUFBTTt3QkFDdEIsY0FBYyxFQUFFLENBQUM7d0JBQ2pCLGVBQWUsRUFBRSxNQUFNO3dCQUN2QixlQUFlLEVBQUUsQ0FBQzt3QkFDbEIsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUM7d0JBQ3ZELElBQUk7d0JBQ0osaUJBQWlCLEVBQUUsUUFBUTt3QkFDM0IsUUFBUSxFQUFFLEtBQUs7d0JBQ2YsU0FBUzt3QkFDVCxxQkFBcUIsRUFBRSxJQUFJO3FCQUM1QixDQUFBO29CQUNELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7b0JBRTFDLE1BQU0sUUFBUSxHQUFpQyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7b0JBQ3RHLE1BQU0sRUFDSixJQUFJLEVBQUUsRUFBRSxhQUFhLEVBQUUsd0JBQXdCLEVBQUUsZ0JBQWdCLEVBQUUsRUFDbkUsTUFBTSxHQUNQLEdBQUcsUUFBUSxDQUFBO29CQUVaLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBO29CQUM1QixNQUFNLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsRUFBRSxDQUFDLENBQUE7b0JBQ3ZELE1BQU0sQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQTtvQkFFckQsSUFBSSxJQUFJLElBQUksU0FBUyxFQUFFO3dCQUNyQixNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLGVBQWUsQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQTtxQkFDOUY7eUJBQU07d0JBQ0wsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQTtxQkFDakc7b0JBRUQsMkpBQTJKO29CQUMzSiw4RUFBOEU7b0JBQzlFLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQTtnQkFDOUMsQ0FBQyxDQUFDLENBQUE7Z0JBRUYsRUFBRSxDQUFDLG9DQUFvQyxFQUFFLEtBQUssSUFBSSxFQUFFO29CQUNsRCxNQUFNLFFBQVEsR0FBcUI7d0JBQ2pDLGNBQWMsRUFBRSxNQUFNO3dCQUN0QixjQUFjLEVBQUUsQ0FBQzt3QkFDakIsZUFBZSxFQUFFLE1BQU07d0JBQ3ZCLGVBQWUsRUFBRSxDQUFDO3dCQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQzt3QkFDdkQsSUFBSTt3QkFDSixTQUFTO3dCQUNULFdBQVcsRUFBRSxhQUFhO3dCQUMxQixxQkFBcUIsRUFBRSxJQUFJO3FCQUM1QixDQUFBO29CQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7b0JBRTFDLE1BQU0sUUFBUSxHQUFpQyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7b0JBQ3RHLE1BQU0sRUFDSixJQUFJLEVBQUUsRUFBRSxhQUFhLEVBQUUsd0JBQXdCLEVBQUUsZ0JBQWdCLEVBQUUsV0FBVyxFQUFFLEVBQ2hGLE1BQU0sR0FDUCxHQUFHLFFBQVEsQ0FBQTtvQkFFWixNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTtvQkFFNUIsSUFBSSxTQUFTLElBQUksT0FBTyxFQUFFO3dCQUN4QixNQUFNLENBQUMsV0FBVyxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQTtxQkFDNUM7b0JBRUQsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFBO29CQUN2RCxNQUFNLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUE7b0JBRXJELElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTt3QkFDckIsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7cUJBQzlGO3lCQUFNO3dCQUNMLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7cUJBQ2pHO29CQUVELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFBO2dCQUMxQyxDQUFDLENBQUMsQ0FBQTtnQkFFRixFQUFFLENBQUMsMkJBQTJCLEVBQUUsS0FBSyxJQUFJLEVBQUU7b0JBQ3pDLE1BQU0sUUFBUSxHQUFxQjt3QkFDakMsY0FBYyxFQUFFLDRDQUE0Qzt3QkFDNUQsY0FBYyxFQUFFLENBQUM7d0JBQ2pCLGVBQWUsRUFBRSw0Q0FBNEM7d0JBQzdELGVBQWUsRUFBRSxDQUFDO3dCQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQzt3QkFDdEQsSUFBSTt3QkFDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87d0JBQ3hCLGlCQUFpQixFQUFFLFFBQVE7d0JBQzNCLFFBQVEsRUFBRSxLQUFLO3dCQUNmLFNBQVM7d0JBQ1QscUJBQXFCLEVBQUUsSUFBSTtxQkFDNUIsQ0FBQTtvQkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO29CQUUxQyxNQUFNLFFBQVEsR0FBaUMsTUFBTSxLQUFLLENBQUMsR0FBRyxDQUFnQixHQUFHLEdBQUcsSUFBSSxXQUFXLEVBQUUsQ0FBQyxDQUFBO29CQUV0RyxNQUFNLEVBQ0osSUFBSSxFQUFFLEVBQUUsYUFBYSxFQUFFLHdCQUF3QixFQUFFLEVBQ2pELE1BQU0sR0FDUCxHQUFHLFFBQVEsQ0FBQTtvQkFFWixNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTtvQkFDNUIsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFBO29CQUV2RCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7d0JBQ3JCLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsZUFBZSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBO3FCQUM5Rjt5QkFBTTt3QkFDTCxNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLGtCQUFrQixDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBO3FCQUNqRztvQkFFRCxNQUFNLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUE7Z0JBQ3ZELENBQUMsQ0FBQyxDQUFBO2dCQUVGLEVBQUUsQ0FBQyw2Q0FBNkMsRUFBRSxLQUFLLElBQUksRUFBRTtvQkFDM0QsTUFBTSxRQUFRLEdBQXFCO3dCQUNqQyxjQUFjLEVBQUUsNENBQTRDO3dCQUM1RCxjQUFjLEVBQUUsQ0FBQzt3QkFDakIsZUFBZSxFQUFFLE1BQU07d0JBQ3ZCLGVBQWUsRUFBRSxDQUFDO3dCQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQzt3QkFDdEQsSUFBSTt3QkFDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87d0JBQ3hCLGlCQUFpQixFQUFFLFFBQVE7d0JBQzNCLFFBQVEsRUFBRSxLQUFLO3dCQUNmLFNBQVM7d0JBQ1QscUJBQXFCLEVBQUUsSUFBSTtxQkFDNUIsQ0FBQTtvQkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO29CQUUxQyxNQUFNLFFBQVEsR0FBaUMsTUFBTSxLQUFLLENBQUMsR0FBRyxDQUFnQixHQUFHLEdBQUcsSUFBSSxXQUFXLEVBQUUsQ0FBQyxDQUFBO29CQUN0RyxNQUFNLEVBQ0osSUFBSSxFQUFFLEVBQUUsYUFBYSxFQUFFLHdCQUF3QixFQUFFLEVBQ2pELE1BQU0sR0FDUCxHQUFHLFFBQVEsQ0FBQTtvQkFFWixNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTtvQkFDNUIsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFBO29CQUV2RCxJQUFJLElBQUksSUFBSSxTQUFTLEVBQUU7d0JBQ3JCLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsZUFBZSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBO3FCQUM5Rjt5QkFBTTt3QkFDTCxNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLGtCQUFrQixDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFBO3FCQUNqRztvQkFFRCxNQUFNLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUE7Z0JBQ3ZELENBQUMsQ0FBQyxDQUFBO1lBQ0osQ0FBQyxDQUFDLENBQUE7WUFFRixRQUFRLENBQUMsR0FBRyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsSUFBSSxTQUFTLElBQUksSUFBSSxNQUFNLEVBQUUsR0FBRyxFQUFFO2dCQUNqRSxFQUFFLENBQUMsMEJBQTBCLEVBQUUsS0FBSyxJQUFJLEVBQUU7b0JBQ3hDLE1BQU0sUUFBUSxHQUE4Qjt3QkFDMUMsZUFBZSxFQUFFLE1BQU07d0JBQ3ZCLGNBQWMsRUFBRSxDQUFDO3dCQUNqQixlQUFlLEVBQUUsQ0FBQzt3QkFDbEIsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUM7d0JBQ3ZELElBQUk7d0JBQ0osU0FBUyxFQUFFLEtBQUssQ0FBQyxPQUFPO3dCQUN4QixpQkFBaUIsRUFBRSxRQUFRO3dCQUMzQixRQUFRLEVBQUUsS0FBSzt3QkFDZixTQUFTO3dCQUNULHFCQUFxQixFQUFFLElBQUk7cUJBQzVCLENBQUE7b0JBRUQsTUFBTSxpQkFBaUIsQ0FBQyxRQUFRLEVBQUU7d0JBQ2hDLE1BQU0sRUFBRSxHQUFHO3dCQUNYLElBQUksRUFBRTs0QkFDSixNQUFNLEVBQUUsOEJBQThCOzRCQUN0QyxTQUFTLEVBQUUsa0JBQWtCO3lCQUM5QjtxQkFDRixDQUFDLENBQUE7Z0JBQ0osQ0FBQyxDQUFDLENBQUE7Z0JBRUYsRUFBRSxDQUFDLElBQUksQ0FBQyxpQ0FBaUMsRUFBRSxLQUFLLElBQUksRUFBRTtvQkFDcEQsTUFBTSxRQUFRLEdBQXFCO3dCQUNqQyxjQUFjLEVBQUUsS0FBSzt3QkFDckIsY0FBYyxFQUFFLENBQUM7d0JBQ2pCLGVBQWUsRUFBRSxLQUFLO3dCQUN0QixlQUFlLEVBQUUsQ0FBQzt3QkFDbEIsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxtREFBbUQsQ0FBQzt3QkFDbkcsSUFBSTt3QkFDSixTQUFTLEVBQUUsNENBQTRDO3dCQUN2RCxpQkFBaUIsRUFBRSxRQUFRO3dCQUMzQixRQUFRLEVBQUUsS0FBSzt3QkFDZixTQUFTO3dCQUNULHFCQUFxQixFQUFFLElBQUk7cUJBQzVCLENBQUE7b0JBRUQsTUFBTSxpQkFBaUIsQ0FBQyxRQUFRLEVBQUU7d0JBQ2hDLE1BQU0sRUFBRSxHQUFHO3dCQUNYLElBQUksRUFBRTs0QkFDSixNQUFNLEVBQUUsZ0JBQWdCOzRCQUN4QixTQUFTLEVBQUUsVUFBVTt5QkFDdEI7cUJBQ0YsQ0FBQyxDQUFBO2dCQUNKLENBQUMsQ0FBQyxDQUFBO2dCQUVGLEVBQUUsQ0FBQywrQkFBK0IsRUFBRSxLQUFLLElBQUksRUFBRTtvQkFDN0MsTUFBTSxRQUFRLEdBQXFCO3dCQUNqQyxjQUFjLEVBQUUsTUFBTTt3QkFDdEIsY0FBYyxFQUFFLENBQUM7d0JBQ2pCLGVBQWUsRUFBRSxNQUFNO3dCQUN2QixlQUFlLEVBQUUsQ0FBQzt3QkFDbEIsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUNyQixDQUFDLEVBQ0QsSUFBSSxFQUNKLE1BQU0sRUFDTixNQUFNLEVBQ04saUhBQWlILENBQ2xIO3dCQUNELElBQUk7d0JBQ0osU0FBUyxFQUFFLEtBQUssQ0FBQyxPQUFPO3dCQUN4QixpQkFBaUIsRUFBRSxRQUFRO3dCQUMzQixRQUFRLEVBQUUsS0FBSzt3QkFDZixTQUFTO3FCQUNWLENBQUE7b0JBRUQsTUFBTSxpQkFBaUIsQ0FBQyxRQUFRLEVBQUU7d0JBQ2hDLE1BQU0sRUFBRSxHQUFHO3dCQUNYLElBQUksRUFBRTs0QkFDSixNQUFNLEVBQUUsa0VBQWtFOzRCQUMxRSxTQUFTLEVBQUUsa0JBQWtCO3lCQUM5QjtxQkFDRixDQUFDLENBQUE7Z0JBQ0osQ0FBQyxDQUFDLENBQUE7Z0JBRUYsRUFBRSxDQUFDLG9CQUFvQixFQUFFLEtBQUssSUFBSSxFQUFFO29CQUNsQyxNQUFNLFFBQVEsR0FBcUI7d0JBQ2pDLGNBQWMsRUFBRSxNQUFNO3dCQUN0QixjQUFjLEVBQUUsQ0FBQzt3QkFDakIsZUFBZSxFQUFFLE1BQU07d0JBQ3ZCLGVBQWUsRUFBRSxDQUFDO3dCQUNsQixNQUFNLEVBQUUsY0FBYzt3QkFDdEIsSUFBSTt3QkFDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87d0JBQ3hCLGlCQUFpQixFQUFFLFFBQVE7d0JBQzNCLFFBQVEsRUFBRSxLQUFLO3dCQUNmLFNBQVM7d0JBQ1QscUJBQXFCLEVBQUUsSUFBSTtxQkFDNUIsQ0FBQTtvQkFFRCxNQUFNLGlCQUFpQixDQUFDLFFBQVEsRUFBRTt3QkFDaEMsTUFBTSxFQUFFLEdBQUc7d0JBQ1gsSUFBSSxFQUFFOzRCQUNKLE1BQU0sRUFBRSxvRkFBb0Y7NEJBQzVGLFNBQVMsRUFBRSxrQkFBa0I7eUJBQzlCO3FCQUNGLENBQUMsQ0FBQTtnQkFDSixDQUFDLENBQUMsQ0FBQTtnQkFFRixFQUFFLENBQUMsbUJBQW1CLEVBQUUsS0FBSyxJQUFJLEVBQUU7b0JBQ2pDLE1BQU0sUUFBUSxHQUFxQjt3QkFDakMsY0FBYyxFQUFFLE1BQU07d0JBQ3RCLGNBQWMsRUFBRSxDQUFDO3dCQUNqQixlQUFlLEVBQUUsTUFBTTt3QkFDdkIsZUFBZSxFQUFFLENBQUM7d0JBQ2xCLE1BQU0sRUFBRSxlQUFlO3dCQUN2QixJQUFJO3dCQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTzt3QkFDeEIsaUJBQWlCLEVBQUUsUUFBUTt3QkFDM0IsUUFBUSxFQUFFLEtBQUs7d0JBQ2YsU0FBUzt3QkFDVCxxQkFBcUIsRUFBRSxJQUFJO3FCQUM1QixDQUFBO29CQUVELE1BQU0saUJBQWlCLENBQUMsUUFBUSxFQUFFO3dCQUNoQyxNQUFNLEVBQUUsR0FBRzt3QkFDWCxJQUFJLEVBQUU7NEJBQ0osTUFBTSxFQUFFLHFGQUFxRjs0QkFDN0YsU0FBUyxFQUFFLGtCQUFrQjt5QkFDOUI7cUJBQ0YsQ0FBQyxDQUFBO2dCQUNKLENBQUMsQ0FBQyxDQUFBO2dCQUVGLEVBQUUsQ0FBQyxxQkFBcUIsRUFBRSxLQUFLLElBQUksRUFBRTtvQkFDbkMsTUFBTSxRQUFRLEdBQXFCO3dCQUNqQyxjQUFjLEVBQUUsTUFBTTt3QkFDdEIsY0FBYyxFQUFFLENBQUM7d0JBQ2pCLGVBQWUsRUFBRSxrQkFBa0I7d0JBQ25DLGVBQWUsRUFBRSxDQUFDO3dCQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQzt3QkFDdkQsSUFBSTt3QkFDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87d0JBQ3hCLGlCQUFpQixFQUFFLFFBQVE7d0JBQzNCLFFBQVEsRUFBRSxLQUFLO3dCQUNmLFNBQVM7cUJBQ1YsQ0FBQTtvQkFFRCxNQUFNLGlCQUFpQixDQUFDLFFBQVEsRUFBRTt3QkFDaEMsTUFBTSxFQUFFLEdBQUc7d0JBQ1gsSUFBSSxFQUFFOzRCQUNKLE1BQU0sRUFBRSxzREFBc0Q7NEJBQzlELFNBQVMsRUFBRSxtQkFBbUI7eUJBQy9CO3FCQUNGLENBQUMsQ0FBQTtnQkFDSixDQUFDLENBQUMsQ0FBQTtnQkFFRixFQUFFLENBQUMsNEJBQTRCLEVBQUUsS0FBSyxJQUFJLEVBQUU7b0JBQzFDLE1BQU0sUUFBUSxHQUFxQjt3QkFDakMsY0FBYyxFQUFFLE1BQU07d0JBQ3RCLGNBQWMsRUFBRSxDQUFDO3dCQUNqQixlQUFlLEVBQUUsTUFBTTt3QkFDdkIsZUFBZSxFQUFFLENBQUM7d0JBQ2xCLE1BQU0sRUFBRSxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDO3dCQUN2RCxJQUFJO3dCQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTzt3QkFDeEIsaUJBQWlCLEVBQUUsUUFBUTt3QkFDM0IsUUFBUSxFQUFFLEtBQUs7d0JBQ2YsU0FBUzt3QkFDVCxxQkFBcUIsRUFBRSxJQUFJO3FCQUM1QixDQUFBO29CQUVELE1BQU0saUJBQWlCLENBQUMsUUFBUSxFQUFFO3dCQUNoQyxNQUFNLEVBQUUsR0FBRzt3QkFDWCxJQUFJLEVBQUU7NEJBQ0osTUFBTSxFQUFFLHdDQUF3Qzs0QkFDaEQsU0FBUyxFQUFFLG1CQUFtQjt5QkFDL0I7cUJBQ0YsQ0FBQyxDQUFBO2dCQUNKLENBQUMsQ0FBQyxDQUFBO2dCQUVGLEVBQUUsQ0FBQyx3Q0FBd0MsRUFBRSxLQUFLLElBQUksRUFBRTtvQkFDdEQsTUFBTSxRQUFRLEdBQXFCO3dCQUNqQyxjQUFjLEVBQUUsTUFBTTt3QkFDdEIsY0FBYyxFQUFFLENBQUM7d0JBQ2pCLGVBQWUsRUFBRSw0Q0FBNEM7d0JBQzdELGVBQWUsRUFBRSxDQUFDO3dCQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQzt3QkFDdkQsSUFBSTt3QkFDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87d0JBQ3hCLGlCQUFpQixFQUFFLFFBQVE7d0JBQzNCLFFBQVEsRUFBRSxLQUFLO3dCQUNmLFNBQVM7d0JBQ1QscUJBQXFCLEVBQUUsSUFBSTtxQkFDNUIsQ0FBQTtvQkFFRCxNQUFNLGlCQUFpQixDQUFDLFFBQVEsRUFBRTt3QkFDaEMsTUFBTSxFQUFFLEdBQUc7d0JBQ1gsSUFBSSxFQUFFOzRCQUNKLE1BQU0sRUFBRSx3Q0FBd0M7NEJBQ2hELFNBQVMsRUFBRSxtQkFBbUI7eUJBQy9CO3FCQUNGLENBQUMsQ0FBQTtnQkFDSixDQUFDLENBQUMsQ0FBQTtnQkFFRixFQUFFLENBQUMsNkJBQTZCLEVBQUUsS0FBSyxJQUFJLEVBQUU7b0JBQzNDLE1BQU0sUUFBUSxHQUFxQjt3QkFDakMsY0FBYyxFQUFFLDRDQUE0Qzt3QkFDNUQsY0FBYyxFQUFFLENBQUM7d0JBQ2pCLGVBQWUsRUFBRSw0Q0FBNEM7d0JBQzdELGVBQWUsRUFBRSxDQUFDO3dCQUNsQixNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQzt3QkFDdkQsSUFBSTt3QkFDSixTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87d0JBQ3hCLGlCQUFpQixFQUFFLFFBQVE7d0JBQzNCLFFBQVEsRUFBRSxLQUFLO3dCQUNmLFNBQVM7d0JBQ1QscUJBQXFCLEVBQUUsSUFBSTtxQkFDNUIsQ0FBQTtvQkFDRCxNQUFNLGlCQUFpQixDQUFDLFFBQVEsRUFBRTt3QkFDaEMsTUFBTSxFQUFFLEdBQUc7d0JBQ1gsSUFBSSxFQUFFOzRCQUNKLE1BQU0sRUFBRSx3Q0FBd0M7NEJBQ2hELFNBQVMsRUFBRSxtQkFBbUI7eUJBQy9CO3FCQUNGLENBQUMsQ0FBQTtnQkFDSixDQUFDLENBQUMsQ0FBQTtnQkFFRixFQUFFLENBQUMsaUNBQWlDLEVBQUUsS0FBSyxJQUFJLEVBQUU7b0JBQy9DLE1BQU0sUUFBUSxHQUFxQjt3QkFDakMsY0FBYyxFQUFFLE1BQU07d0JBQ3RCLGNBQWMsRUFBRSxDQUFDO3dCQUNqQixlQUFlLEVBQUUsTUFBTTt3QkFDdkIsZUFBZSxFQUFFLENBQUM7d0JBQ2xCLE1BQU0sRUFBRSxNQUFNLFNBQVMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDO3dCQUN2RCxJQUFJO3dCQUNKLFNBQVMsRUFBRSwrQ0FBK0M7d0JBQzFELGlCQUFpQixFQUFFLFFBQVE7d0JBQzNCLFFBQVEsRUFBRSxLQUFLO3dCQUNmLFNBQVM7d0JBQ1QscUJBQXFCLEVBQUUsSUFBSTtxQkFDNUIsQ0FBQTtvQkFFRCxNQUFNLGlCQUFpQixDQUFDLFFBQVEsRUFBRTt3QkFDaEMsTUFBTSxFQUFFLEdBQUc7d0JBQ1gsSUFBSSxFQUFFOzRCQUNKLE1BQU0sRUFDSixtSUFBbUk7NEJBQ3JJLFNBQVMsRUFBRSxrQkFBa0I7eUJBQzlCO3FCQUNGLENBQUMsQ0FBQTtnQkFDSixDQUFDLENBQUMsQ0FBQTtnQkFFRixFQUFFLENBQUMsbUJBQW1CLEVBQUUsS0FBSyxJQUFJLEVBQUU7b0JBQ2pDLE1BQU0sUUFBUSxHQUFxQjt3QkFDakMsY0FBYyxFQUFFLE1BQU07d0JBQ3RCLGNBQWMsRUFBRSxFQUFFO3dCQUNsQixlQUFlLEVBQUUsTUFBTTt3QkFDdkIsZUFBZSxFQUFFLEVBQUU7d0JBQ25CLE1BQU0sRUFBRSxhQUFhO3dCQUNyQixJQUFJO3dCQUNKLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTzt3QkFDeEIsaUJBQWlCLEVBQUUsUUFBUTt3QkFDM0IsUUFBUSxFQUFFLEtBQUs7d0JBQ2YsU0FBUzt3QkFDVCxxQkFBcUIsRUFBRSxJQUFJO3FCQUM1QixDQUFBO29CQUVELE1BQU0sTUFBTSxHQUFHLGdCQUFnQixDQUFDLE1BQU0sRUFBRSxDQUFBO29CQUN4QyxNQUFNLFFBQVEsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLENBQUMsUUFBUSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQTtvQkFFN0QsTUFBTSxpQkFBaUIsQ0FBQyxRQUFRLEVBQUU7d0JBQ2hDLE1BQU0sRUFBRSxHQUFHO3dCQUNYLElBQUksRUFBRTs0QkFDSixNQUFNLEVBQUUsb0NBQW9DLFFBQVEsR0FBRzs0QkFDdkQsU0FBUyxFQUFFLGtCQUFrQjt5QkFDOUI7cUJBQ0YsQ0FBQyxDQUFBO2dCQUNKLENBQUMsQ0FBQyxDQUFBO1lBQ0osQ0FBQyxDQUFDLENBQUE7U0FDSDtLQUNGO0lBRUQsTUFBTSxZQUFZLEdBQWlEO1FBQ2pFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7UUFDbkMsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUM7UUFDL0MsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUM7UUFDakQsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUM7UUFDbkQsQ0FBQyxPQUFPLENBQUMsZUFBZSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUM7UUFDakUsQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUM7UUFDM0QsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUM7UUFDakQsQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUM7UUFDL0QsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsU0FBUztRQUMvQixDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxtQkFBbUI7UUFDbkQsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSTtRQUM5QixDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxJQUFJO1FBQzVCLENBQUMsT0FBTyxDQUFDLGVBQWUsQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDLElBQUk7UUFDckMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUM7UUFDekMsQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSTtRQUNqQyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQztRQUNyRCxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQztRQUN6RCxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQztLQUM1QyxDQUFBO0lBRUQsTUFBTSxZQUFZLEdBQWlEO1FBQ2pFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7UUFDbEMsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUM7UUFDOUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUM7UUFDaEQsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUM7UUFDbEQsQ0FBQyxPQUFPLENBQUMsZUFBZSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUM7UUFDaEUsQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUM7UUFDMUQsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUM7UUFDaEQsQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUM7UUFDOUQsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsU0FBUztRQUMvQixDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxtQkFBbUI7UUFDbkQsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSTtRQUM5QixDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxJQUFJO1FBQzVCLENBQUMsT0FBTyxDQUFDLGVBQWUsQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDLElBQUk7UUFDckMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUM7UUFDekMsQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSTtRQUNqQyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQztRQUNwRCxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQztRQUM1RCxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQztLQUMvQyxDQUFBO0lBRUQscUdBQXFHO0lBQ3JHLEtBQUssTUFBTSxLQUFLLElBQUksQ0FBQyxDQUFDLE1BQU0sQ0FDMUIsZ0JBQWdCLEVBQ2hCLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FDSixDQUFDLElBQUksT0FBTyxDQUFDLGNBQWM7UUFDM0IsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxlQUFlO1FBQzVCLENBQUMsSUFBSSxPQUFPLENBQUMsY0FBYztRQUMzQixDQUFDLElBQUksT0FBTyxDQUFDLE1BQU07UUFDbkIsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxPQUFPLENBQ3ZCLEVBQUU7UUFDRCxLQUFLLE1BQU0sSUFBSSxJQUFJLENBQUMsU0FBUyxFQUFFLFVBQVUsQ0FBQyxFQUFFO1lBQzFDLE1BQU0sSUFBSSxHQUFHLFlBQVksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFBO1lBQ2xDLE1BQU0sSUFBSSxHQUFHLFlBQVksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFBO1lBRWxDLHdFQUF3RTtZQUN4RSxJQUFJLElBQUksSUFBSSxJQUFJLElBQUksSUFBSSxJQUFJLElBQUk7Z0JBQUUsU0FBUTtZQUUxQyxRQUFRLENBQUMsR0FBRyxrQkFBa0IsQ0FBQyxLQUFLLENBQUMsSUFBSSxJQUFJLE1BQU0sRUFBRTtnQkFDbkQsd0NBQXdDO2dCQUN4QyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFBO2dCQUNmLE1BQU0sYUFBYSxHQUFHLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQTtnQkFFdkMsRUFBRSxDQUFDLEdBQUcsYUFBYSxDQUFDLE1BQU0sV0FBVyxFQUFFLEtBQUssSUFBSSxFQUFFO29CQUNoRCxNQUFNLFFBQVEsR0FBcUI7d0JBQ2pDLGNBQWMsRUFBRSxhQUFhLENBQUMsT0FBTzt3QkFDckMsY0FBYyxFQUFFLEtBQUs7d0JBQ3JCLGVBQWUsRUFBRSxJQUFJLENBQUMsT0FBTzt3QkFDN0IsZUFBZSxFQUFFLEtBQUs7d0JBQ3RCLE1BQU0sRUFBRSxNQUFNLGtCQUFrQixDQUFDLElBQUksRUFBRSxhQUFhLEVBQUUsSUFBSSxFQUFFLEdBQUcsQ0FBQzt3QkFDaEUsSUFBSTt3QkFDSixxQkFBcUIsRUFBRSxJQUFJO3FCQUM1QixDQUFBO29CQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7b0JBRTFDLElBQUk7d0JBQ0YsTUFBTSxRQUFRLEdBQWlDLE1BQU0sS0FBSyxDQUFDLEdBQUcsQ0FBZ0IsR0FBRyxHQUFHLElBQUksV0FBVyxFQUFFLENBQUMsQ0FBQTt3QkFDdEcsTUFBTSxFQUFFLE1BQU0sRUFBRSxHQUFHLFFBQVEsQ0FBQTt3QkFFM0IsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7cUJBQzdCO29CQUFDLE9BQU8sR0FBUSxFQUFFO3dCQUNqQixJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUE7cUJBQ3hDO2dCQUNILENBQUMsQ0FBQyxDQUFBO2dCQUVGLEVBQUUsQ0FBQyxnQkFBZ0IsRUFBRSxLQUFLLElBQUksRUFBRTtvQkFDOUIsTUFBTSxRQUFRLEdBQXFCO3dCQUNqQyxjQUFjLEVBQUUsSUFBSSxDQUFDLE9BQU87d0JBQzVCLGNBQWMsRUFBRSxLQUFLO3dCQUNyQixlQUFlLEVBQUUsSUFBSSxDQUFDLE9BQU87d0JBQzdCLGVBQWUsRUFBRSxLQUFLO3dCQUN0QixNQUFNLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxHQUFHLENBQUM7d0JBQ3ZELElBQUk7cUJBQ0wsQ0FBQTtvQkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO29CQUUxQyxJQUFJO3dCQUNGLE1BQU0sUUFBUSxHQUFpQyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7d0JBQ3RHLE1BQU0sRUFBRSxNQUFNLEVBQUUsR0FBRyxRQUFRLENBQUE7d0JBRTNCLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBO3FCQUM3QjtvQkFBQyxPQUFPLEdBQVEsRUFBRTt3QkFDakIsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFBO3FCQUN4QztnQkFDSCxDQUFDLENBQUMsQ0FBQTtnQkFDRixNQUFNLE1BQU0sR0FBRyxlQUFlLENBQUMsS0FBSyxDQUFDLENBQUE7Z0JBQ3JDLEVBQUUsQ0FBQyxHQUFHLE1BQU0sV0FBVyxFQUFFLEtBQUssSUFBSSxFQUFFO29CQUNsQywwRkFBMEY7b0JBQzFGLHVIQUF1SDtvQkFDdkgsTUFBTSxTQUFTLEdBQUcsS0FBSyxJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQTtvQkFFdEUsTUFBTSxRQUFRLEdBQXFCO3dCQUNqQyxjQUFjLEVBQUUsTUFBTTt3QkFDdEIsY0FBYyxFQUFFLEtBQUs7d0JBQ3JCLGVBQWUsRUFBRSxTQUFTLENBQUMsT0FBTzt3QkFDbEMsZUFBZSxFQUFFLEtBQUs7d0JBQ3RCLE1BQU0sRUFBRSxNQUFNLGtCQUFrQixDQUFDLElBQUksRUFBRSxVQUFVLENBQUMsS0FBSyxDQUFDLEVBQUUsU0FBUyxFQUFFLEdBQUcsQ0FBQzt3QkFDekUsSUFBSTt3QkFDSixxQkFBcUIsRUFBRSxJQUFJO3FCQUM1QixDQUFBO29CQUVELE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7b0JBQzFDLElBQUk7d0JBQ0YsTUFBTSxRQUFRLEdBQWlDLE1BQU0sS0FBSyxDQUFDLEdBQUcsQ0FBZ0IsR0FBRyxHQUFHLElBQUksV0FBVyxFQUFFLENBQUMsQ0FBQTt3QkFDdEcsTUFBTSxFQUFFLE1BQU0sRUFBRSxHQUFHLFFBQVEsQ0FBQTt3QkFFM0IsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUE7cUJBQzVEO29CQUFDLE9BQU8sR0FBUSxFQUFFO3dCQUNqQixJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUE7cUJBQ3hDO2dCQUNILENBQUMsQ0FBQyxDQUFBO2dCQUNGLEVBQUUsQ0FBQyw2QkFBNkIsRUFBRSxLQUFLLElBQUksRUFBRTtvQkFDM0MsTUFBTSxRQUFRLEdBQXFCO3dCQUNqQyxjQUFjLEVBQUUsSUFBSSxDQUFDLE9BQU87d0JBQzVCLGNBQWMsRUFBRSxLQUFLO3dCQUNyQixlQUFlLEVBQUUsSUFBSSxDQUFDLE9BQU87d0JBQzdCLGVBQWUsRUFBRSxLQUFLO3dCQUN0QixNQUFNLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxHQUFHLENBQUM7d0JBQ3ZELElBQUk7cUJBQ0wsQ0FBQTtvQkFFRCxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO29CQUUxQyxJQUFJO3dCQUNGLE1BQU0sUUFBUSxHQUFpQyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQWdCLEdBQUcsR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDLENBQUE7d0JBQ3RHLE1BQU0sRUFDSixJQUFJLEVBQUUsRUFBRSxhQUFhLEVBQUUsd0JBQXdCLEVBQUUsRUFDakQsTUFBTSxHQUNQLEdBQUcsUUFBUSxDQUFBO3dCQUVaLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBO3dCQUU1QixzQ0FBc0M7d0JBQ3RDLElBQUksSUFBSSxJQUFJLFNBQVMsRUFBRTs0QkFDckIsTUFBTSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7eUJBQzlGOzZCQUFNOzRCQUNMLE1BQU0sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUE7eUJBQ2pHO3FCQUNGO29CQUFDLE9BQU8sR0FBUSxFQUFFO3dCQUNqQixJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUE7cUJBQ3hDO2dCQUNILENBQUMsQ0FBQyxDQUFBO1lBQ0osQ0FBQyxDQUFDLENBQUE7U0FDSDtLQUNGO0FBQ0gsQ0FBQyxDQUFDLENBQUE7QUFFRixRQUFRLENBQUMsa0JBQWtCLEVBQUU7SUFDM0IsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQTtJQUVsQixLQUFLLE1BQU0sSUFBSSxJQUFJLENBQUMsU0FBUyxFQUFFLFVBQVUsQ0FBQyxFQUFFO1FBQzFDLFFBQVEsQ0FBQyxHQUFHLElBQUksTUFBTSxFQUFFLEdBQUcsRUFBRSxHQUFFLENBQUMsQ0FBQyxDQUFBO0tBQ2xDO0FBQ0gsQ0FBQyxDQUFDLENBQUEiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBTaWduZXJXaXRoQWRkcmVzcyB9IGZyb20gJ0Bub21pY2xhYnMvaGFyZGhhdC1ldGhlcnMvc2lnbmVycydcbmltcG9ydCB7IEFsbG93YW5jZVRyYW5zZmVyLCBQZXJtaXRTaW5nbGUgfSBmcm9tICdAdW5pc3dhcC9wZXJtaXQyLXNkaydcbmltcG9ydCB7IENoYWluSWQsIEN1cnJlbmN5LCBDdXJyZW5jeUFtb3VudCwgRXRoZXIsIEZyYWN0aW9uLCBSb3VuZGluZywgVG9rZW4sIFdFVEg5IH0gZnJvbSAnQHVuaXN3YXAvc2RrLWNvcmUnXG5pbXBvcnQge1xuICBDRVVSX0NFTE8sXG4gIENFVVJfQ0VMT19BTEZBSk9SRVMsXG4gIENVU0RfQ0VMTyxcbiAgQ1VTRF9DRUxPX0FMRkFKT1JFUyxcbiAgREFJX01BSU5ORVQsXG4gIElEX1RPX05FVFdPUktfTkFNRSxcbiAgTkFUSVZFX0NVUlJFTkNZLFxuICBwYXJzZUFtb3VudCxcbiAgU1dBUF9ST1VURVJfMDJfQUREUkVTU0VTLFxuICBVU0RDX01BSU5ORVQsXG4gIFVTRFRfTUFJTk5FVCxcbiAgV0JUQ19NQUlOTkVULFxufSBmcm9tICdAdW5pc3dhcC9zbWFydC1vcmRlci1yb3V0ZXInXG5pbXBvcnQge1xuICBQRVJNSVQyX0FERFJFU1MsXG4gIFVOSVZFUlNBTF9ST1VURVJfQUREUkVTUyBhcyBVTklWRVJTQUxfUk9VVEVSX0FERFJFU1NfQllfQ0hBSU4sXG59IGZyb20gJ0B1bmlzd2FwL3VuaXZlcnNhbC1yb3V0ZXItc2RrJ1xuaW1wb3J0IHsgTWV0aG9kUGFyYW1ldGVycyB9IGZyb20gJ0B1bmlzd2FwL3NtYXJ0LW9yZGVyLXJvdXRlcidcbmltcG9ydCB7IGZhaWwgfSBmcm9tICdhc3NlcnQnXG5pbXBvcnQgYXhpb3NTdGF0aWMsIHsgQXhpb3NSZXNwb25zZSB9IGZyb20gJ2F4aW9zJ1xuaW1wb3J0IGF4aW9zUmV0cnkgZnJvbSAnYXhpb3MtcmV0cnknXG5pbXBvcnQgY2hhaSwgeyBleHBlY3QgfSBmcm9tICdjaGFpJ1xuaW1wb3J0IGNoYWlBc1Byb21pc2VkIGZyb20gJ2NoYWktYXMtcHJvbWlzZWQnXG5pbXBvcnQgY2hhaVN1YnNldCBmcm9tICdjaGFpLXN1YnNldCdcbmltcG9ydCB7IEJpZ051bWJlciwgcHJvdmlkZXJzLCBXYWxsZXQgfSBmcm9tICdldGhlcnMnXG5pbXBvcnQgaHJlIGZyb20gJ2hhcmRoYXQnXG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnXG5pbXBvcnQgcXMgZnJvbSAncXMnXG5pbXBvcnQgeyBTVVBQT1JURURfQ0hBSU5TIH0gZnJvbSAnLi4vLi4vLi4vbGliL2hhbmRsZXJzL2luamVjdG9yLXNvcidcbmltcG9ydCB7IFF1b3RlUXVlcnlQYXJhbXMgfSBmcm9tICcuLi8uLi8uLi9saWIvaGFuZGxlcnMvcXVvdGUvc2NoZW1hL3F1b3RlLXNjaGVtYSdcbmltcG9ydCB7IFF1b3RlUmVzcG9uc2UgfSBmcm9tICcuLi8uLi8uLi9saWIvaGFuZGxlcnMvc2NoZW1hJ1xuaW1wb3J0IHsgUGVybWl0Ml9fZmFjdG9yeSB9IGZyb20gJy4uLy4uLy4uL2xpYi90eXBlcy9leHQnXG5pbXBvcnQgeyByZXNldEFuZEZ1bmRBdEJsb2NrIH0gZnJvbSAnLi4vLi4vdXRpbHMvZm9ya0FuZEZ1bmQnXG5pbXBvcnQgeyBnZXRCYWxhbmNlLCBnZXRCYWxhbmNlQW5kQXBwcm92ZSB9IGZyb20gJy4uLy4uL3V0aWxzL2dldEJhbGFuY2VBbmRBcHByb3ZlJ1xuaW1wb3J0IHsgREFJX09OLCBnZXRBbW91bnQsIGdldEFtb3VudEZyb21Ub2tlbiwgVU5JX01BSU5ORVQsIFVTRENfT04sIFVTRFRfT04sIFdOQVRJVkVfT04gfSBmcm9tICcuLi8uLi91dGlscy90b2tlbnMnXG5pbXBvcnQgeyBGTEFUX1BPUlRJT04sIEdSRUVOTElTVF9UT0tFTl9QQUlSUywgUG9ydGlvbiB9IGZyb20gJy4uLy4uL3Rlc3QtdXRpbHMvbW9ja2VkLWRhdGEnXG5cbmNvbnN0IHsgZXRoZXJzIH0gPSBocmVcblxuY2hhaS51c2UoY2hhaUFzUHJvbWlzZWQpXG5jaGFpLnVzZShjaGFpU3Vic2V0KVxuXG5jb25zdCBVTklWRVJTQUxfUk9VVEVSX0FERFJFU1MgPSBVTklWRVJTQUxfUk9VVEVSX0FERFJFU1NfQllfQ0hBSU4oMSlcblxuaWYgKCFwcm9jZXNzLmVudi5VTklTV0FQX1JPVVRJTkdfQVBJIHx8ICFwcm9jZXNzLmVudi5BUkNISVZFX05PREVfUlBDKSB7XG4gIHRocm93IG5ldyBFcnJvcignTXVzdCBzZXQgVU5JU1dBUF9ST1VUSU5HX0FQSSBhbmQgQVJDSElWRV9OT0RFX1JQQyBlbnYgdmFyaWFibGVzIGZvciBpbnRlZyB0ZXN0cy4gU2VlIFJFQURNRScpXG59XG5cbmNvbnN0IEFQSSA9IGAke3Byb2Nlc3MuZW52LlVOSVNXQVBfUk9VVElOR19BUEkhfXF1b3RlYFxuXG5jb25zdCBTTElQUEFHRSA9ICc1J1xuY29uc3QgTEFSR0VfU0xJUFBBR0UgPSAnMjAnXG5cbmNvbnN0IEJVTExFVCA9IG5ldyBUb2tlbihcbiAgQ2hhaW5JZC5NQUlOTkVULFxuICAnMHg4ZWYzMmEwMzc4NGM4RmQ2M2JCZjAyNzI1MWI5NjIwODY1YkQ1NEI2JyxcbiAgOCxcbiAgJ0JVTExFVCcsXG4gICdCdWxsZXQgR2FtZSBCZXR0aW5nIFRva2VuJ1xuKVxuY29uc3QgQlVMTEVUX1dIVF9UQVggPSBuZXcgVG9rZW4oXG4gIENoYWluSWQuTUFJTk5FVCxcbiAgJzB4OGVmMzJhMDM3ODRjOEZkNjNiQmYwMjcyNTFiOTYyMDg2NWJENTRCNicsXG4gIDgsXG4gICdCVUxMRVQnLFxuICAnQnVsbGV0IEdhbWUgQmV0dGluZyBUb2tlbicsXG4gIGZhbHNlLFxuICBCaWdOdW1iZXIuZnJvbSg1MDApLFxuICBCaWdOdW1iZXIuZnJvbSg1MDApXG4pXG5cbmNvbnN0IGF4aW9zID0gYXhpb3NTdGF0aWMuY3JlYXRlKClcbmF4aW9zUmV0cnkoYXhpb3MsIHtcbiAgcmV0cmllczogMTAsXG4gIHJldHJ5Q29uZGl0aW9uOiAoZXJyKSA9PiBlcnIucmVzcG9uc2U/LnN0YXR1cyA9PSA0MjksXG4gIHJldHJ5RGVsYXk6IGF4aW9zUmV0cnkuZXhwb25lbnRpYWxEZWxheSxcbn0pXG5cbmNvbnN0IGNhbGxBbmRFeHBlY3RGYWlsID0gYXN5bmMgKHF1b3RlUmVxOiBQYXJ0aWFsPFF1b3RlUXVlcnlQYXJhbXM+LCByZXNwOiB7IHN0YXR1czogbnVtYmVyOyBkYXRhOiBhbnkgfSkgPT4ge1xuICBjb25zdCBxdWVyeVBhcmFtcyA9IHFzLnN0cmluZ2lmeShxdW90ZVJlcSlcbiAgdHJ5IHtcbiAgICBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgZmFpbCgpXG4gIH0gY2F0Y2ggKGVycjogYW55KSB7XG4gICAgZXhwZWN0KGVyci5yZXNwb25zZSkudG8uY29udGFpblN1YnNldChyZXNwKVxuICB9XG59XG5cbmNvbnN0IGNoZWNrUXVvdGVUb2tlbiA9IChcbiAgYmVmb3JlOiBDdXJyZW5jeUFtb3VudDxDdXJyZW5jeT4sXG4gIGFmdGVyOiBDdXJyZW5jeUFtb3VudDxDdXJyZW5jeT4sXG4gIHRva2Vuc1F1b3RlZDogQ3VycmVuY3lBbW91bnQ8Q3VycmVuY3k+XG4pID0+IHtcbiAgLy8gQ2hlY2sgd2hpY2ggaXMgYmlnZ2VyIHRvIHN1cHBvcnQgZXhhY3RJbiBhbmQgZXhhY3RPdXRcbiAgY29uc3QgdG9rZW5zU3dhcHBlZCA9IGFmdGVyLmdyZWF0ZXJUaGFuKGJlZm9yZSkgPyBhZnRlci5zdWJ0cmFjdChiZWZvcmUpIDogYmVmb3JlLnN1YnRyYWN0KGFmdGVyKVxuXG4gIGNvbnN0IHRva2Vuc0RpZmYgPSB0b2tlbnNRdW90ZWQuZ3JlYXRlclRoYW4odG9rZW5zU3dhcHBlZClcbiAgICA/IHRva2Vuc1F1b3RlZC5zdWJ0cmFjdCh0b2tlbnNTd2FwcGVkKVxuICAgIDogdG9rZW5zU3dhcHBlZC5zdWJ0cmFjdCh0b2tlbnNRdW90ZWQpXG4gIGNvbnN0IHBlcmNlbnREaWZmID0gdG9rZW5zRGlmZi5hc0ZyYWN0aW9uLmRpdmlkZSh0b2tlbnNRdW90ZWQuYXNGcmFjdGlvbilcbiAgZXhwZWN0KHBlcmNlbnREaWZmLmxlc3NUaGFuKG5ldyBGcmFjdGlvbihwYXJzZUludChTTElQUEFHRSksIDEwMCkpKS50by5iZS50cnVlXG59XG5cbmNvbnN0IGNoZWNrUG9ydGlvblJlY2lwaWVudFRva2VuID0gKFxuICBiZWZvcmU6IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5PixcbiAgYWZ0ZXI6IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5PixcbiAgZXhwZWN0ZWRQb3J0aW9uQW1vdW50UmVjZWl2ZWQ6IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5PlxuKSA9PiB7XG4gIGNvbnN0IGFjdHVhbFBvcnRpb25BbW91bnRSZWNlaXZlZCA9IGFmdGVyLnN1YnRyYWN0KGJlZm9yZSlcblxuICBjb25zdCB0b2tlbnNEaWZmID0gZXhwZWN0ZWRQb3J0aW9uQW1vdW50UmVjZWl2ZWQuZ3JlYXRlclRoYW4oYWN0dWFsUG9ydGlvbkFtb3VudFJlY2VpdmVkKVxuICAgID8gZXhwZWN0ZWRQb3J0aW9uQW1vdW50UmVjZWl2ZWQuc3VidHJhY3QoYWN0dWFsUG9ydGlvbkFtb3VudFJlY2VpdmVkKVxuICAgIDogYWN0dWFsUG9ydGlvbkFtb3VudFJlY2VpdmVkLnN1YnRyYWN0KGV4cGVjdGVkUG9ydGlvbkFtb3VudFJlY2VpdmVkKVxuICAvLyBUaGVyZSB3aWxsIGJlIGEgc2xpZ2h0IGRpZmZlcmVuY2UgYmV0d2VlbiBleHBlY3RlZCBhbmQgYWN0dWFsIGR1ZSB0byBzbGlwcGFnZSBkdXJpbmcgdGhlIGhhcmRoYXQgZm9yayBzd2FwLlxuICBjb25zdCBwZXJjZW50RGlmZiA9IHRva2Vuc0RpZmYuYXNGcmFjdGlvbi5kaXZpZGUoZXhwZWN0ZWRQb3J0aW9uQW1vdW50UmVjZWl2ZWQuYXNGcmFjdGlvbilcbiAgZXhwZWN0KHBlcmNlbnREaWZmLmxlc3NUaGFuKG5ldyBGcmFjdGlvbihwYXJzZUludChTTElQUEFHRSksIDEwMCkpKS50by5iZS50cnVlXG59XG5cbmxldCB3YXJuZWRUZXN0ZXJQSyA9IGZhbHNlXG5jb25zdCBpc1Rlc3RlclBLRW52aXJvbm1lbnRTZXQgPSAoKTogYm9vbGVhbiA9PiB7XG4gIGNvbnN0IGlzU2V0ID0gISFwcm9jZXNzLmVudi5URVNURVJfUEtcbiAgaWYgKCFpc1NldCAmJiAhd2FybmVkVGVzdGVyUEspIHtcbiAgICBjb25zb2xlLmxvZygnU2tpcHBpbmcgdGVzdHMgcmVxdWlyaW5nIHJlYWwgUEsgc2luY2UgZW52IHZhcmlhYmxlcyBmb3IgVEVTVEVSX1BLIGlzIG5vdCBzZXQuJylcbiAgICB3YXJuZWRUZXN0ZXJQSyA9IHRydWVcbiAgfVxuICByZXR1cm4gaXNTZXRcbn1cblxuY29uc3QgTUFYX1VJTlQxNjAgPSAnMHhmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmJ1xuXG5kZXNjcmliZSgncXVvdGUnLCBmdW5jdGlvbiAoKSB7XG4gIC8vIEhlbHAgd2l0aCB0ZXN0IGZsYWtpbmVzcyBieSByZXRyeWluZy5cbiAgdGhpcy5yZXRyaWVzKDApXG5cbiAgdGhpcy50aW1lb3V0KCc1MDBzJylcblxuICBsZXQgYWxpY2U6IFNpZ25lcldpdGhBZGRyZXNzXG4gIGxldCBibG9jazogbnVtYmVyXG4gIGxldCBjdXJOb25jZTogbnVtYmVyID0gMFxuICBsZXQgbmV4dFBlcm1pdE5vbmNlOiAoKSA9PiBzdHJpbmcgPSAoKSA9PiB7XG4gICAgY29uc3Qgbm9uY2UgPSBjdXJOb25jZS50b1N0cmluZygpXG4gICAgY3VyTm9uY2UgPSBjdXJOb25jZSArIDFcbiAgICByZXR1cm4gbm9uY2VcbiAgfVxuXG4gIGNvbnN0IGV4ZWN1dGVTd2FwID0gYXN5bmMgKFxuICAgIG1ldGhvZFBhcmFtZXRlcnM6IE1ldGhvZFBhcmFtZXRlcnMsXG4gICAgY3VycmVuY3lJbjogQ3VycmVuY3ksXG4gICAgY3VycmVuY3lPdXQ6IEN1cnJlbmN5LFxuICAgIHBlcm1pdD86IGJvb2xlYW4sXG4gICAgY2hhaW5JZCA9IENoYWluSWQuTUFJTk5FVCxcbiAgICBwb3J0aW9uPzogUG9ydGlvblxuICApOiBQcm9taXNlPHtcbiAgICB0b2tlbkluQWZ0ZXI6IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5PlxuICAgIHRva2VuSW5CZWZvcmU6IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5PlxuICAgIHRva2VuT3V0QWZ0ZXI6IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5PlxuICAgIHRva2VuT3V0QmVmb3JlOiBDdXJyZW5jeUFtb3VudDxDdXJyZW5jeT5cbiAgICB0b2tlbk91dFBvcnRpb25SZWNpcGllbnRCZWZvcmU/OiBDdXJyZW5jeUFtb3VudDxDdXJyZW5jeT5cbiAgICB0b2tlbk91dFBvcnRpb25SZWNpcGllbnRBZnRlcj86IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5PlxuICB9PiA9PiB7XG4gICAgY29uc3QgcGVybWl0MiA9IFBlcm1pdDJfX2ZhY3RvcnkuY29ubmVjdChQRVJNSVQyX0FERFJFU1MsIGFsaWNlKVxuICAgIGNvbnN0IHBvcnRpb25SZWNpcGllbnRTaWduZXIgPSBwb3J0aW9uPy5yZWNpcGllbnQgPyBhd2FpdCBldGhlcnMuZ2V0U2lnbmVyKHBvcnRpb24/LnJlY2lwaWVudCkgOiB1bmRlZmluZWRcblxuICAgIC8vIEFwcHJvdmUgUGVybWl0MlxuICAgIGNvbnN0IHRva2VuSW5CZWZvcmUgPSBhd2FpdCBnZXRCYWxhbmNlQW5kQXBwcm92ZShhbGljZSwgUEVSTUlUMl9BRERSRVNTLCBjdXJyZW5jeUluKVxuICAgIGNvbnN0IHRva2VuT3V0QmVmb3JlID0gYXdhaXQgZ2V0QmFsYW5jZShhbGljZSwgY3VycmVuY3lPdXQpXG4gICAgY29uc3QgdG9rZW5PdXRQb3J0aW9uUmVjaXBpZW50QmVmb3JlID0gcG9ydGlvblJlY2lwaWVudFNpZ25lclxuICAgICAgPyBhd2FpdCBnZXRCYWxhbmNlKHBvcnRpb25SZWNpcGllbnRTaWduZXIsIGN1cnJlbmN5T3V0KVxuICAgICAgOiB1bmRlZmluZWRcblxuICAgIC8vIEFwcHJvdmUgU3dhcFJvdXRlcjAyIGluIGNhc2Ugd2UgcmVxdWVzdCBjYWxsZGF0YSBmb3IgaXQgaW5zdGVhZCBvZiBVbml2ZXJzYWwgUm91dGVyXG4gICAgYXdhaXQgZ2V0QmFsYW5jZUFuZEFwcHJvdmUoYWxpY2UsIFNXQVBfUk9VVEVSXzAyX0FERFJFU1NFUyhjaGFpbklkKSwgY3VycmVuY3lJbilcblxuICAgIC8vIElmIG5vdCB1c2luZyBwZXJtaXQgZG8gYSByZWd1bGFyIGFwcHJvdmFsIGFsbG93aW5nIG5hcndoYWwgbWF4IGJhbGFuY2UuXG4gICAgaWYgKCFwZXJtaXQpIHtcbiAgICAgIGNvbnN0IGFwcHJvdmVOYXJ3aGFsID0gYXdhaXQgcGVybWl0Mi5hcHByb3ZlKFxuICAgICAgICBjdXJyZW5jeUluLndyYXBwZWQuYWRkcmVzcyxcbiAgICAgICAgVU5JVkVSU0FMX1JPVVRFUl9BRERSRVNTLFxuICAgICAgICBNQVhfVUlOVDE2MCxcbiAgICAgICAgMTAwMDAwMDAwMDAwMDAwXG4gICAgICApXG4gICAgICBhd2FpdCBhcHByb3ZlTmFyd2hhbC53YWl0KClcbiAgICB9XG5cbiAgICBjb25zdCB0cmFuc2FjdGlvbiA9IHtcbiAgICAgIGRhdGE6IG1ldGhvZFBhcmFtZXRlcnMuY2FsbGRhdGEsXG4gICAgICB0bzogbWV0aG9kUGFyYW1ldGVycy50byxcbiAgICAgIHZhbHVlOiBCaWdOdW1iZXIuZnJvbShtZXRob2RQYXJhbWV0ZXJzLnZhbHVlKSxcbiAgICAgIGZyb206IGFsaWNlLmFkZHJlc3MsXG4gICAgICBnYXNQcmljZTogQmlnTnVtYmVyLmZyb20oMjAwMDAwMDAwMDAwMCksXG4gICAgICB0eXBlOiAxLFxuICAgIH1cblxuICAgIGNvbnN0IHRyYW5zYWN0aW9uUmVzcG9uc2U6IHByb3ZpZGVycy5UcmFuc2FjdGlvblJlc3BvbnNlID0gYXdhaXQgYWxpY2Uuc2VuZFRyYW5zYWN0aW9uKHRyYW5zYWN0aW9uKVxuICAgIGF3YWl0IHRyYW5zYWN0aW9uUmVzcG9uc2Uud2FpdCgpXG5cbiAgICBjb25zdCB0b2tlbkluQWZ0ZXIgPSBhd2FpdCBnZXRCYWxhbmNlKGFsaWNlLCBjdXJyZW5jeUluKVxuICAgIGNvbnN0IHRva2VuT3V0QWZ0ZXIgPSBhd2FpdCBnZXRCYWxhbmNlKGFsaWNlLCBjdXJyZW5jeU91dClcbiAgICBjb25zdCB0b2tlbk91dFBvcnRpb25SZWNpcGllbnRBZnRlciA9IHBvcnRpb25SZWNpcGllbnRTaWduZXJcbiAgICAgID8gYXdhaXQgZ2V0QmFsYW5jZShwb3J0aW9uUmVjaXBpZW50U2lnbmVyLCBjdXJyZW5jeU91dClcbiAgICAgIDogdW5kZWZpbmVkXG5cbiAgICByZXR1cm4ge1xuICAgICAgdG9rZW5JbkFmdGVyLFxuICAgICAgdG9rZW5JbkJlZm9yZSxcbiAgICAgIHRva2VuT3V0QWZ0ZXIsXG4gICAgICB0b2tlbk91dEJlZm9yZSxcbiAgICAgIHRva2VuT3V0UG9ydGlvblJlY2lwaWVudEJlZm9yZSxcbiAgICAgIHRva2VuT3V0UG9ydGlvblJlY2lwaWVudEFmdGVyLFxuICAgIH1cbiAgfVxuXG4gIGJlZm9yZShhc3luYyBmdW5jdGlvbiAoKSB7XG4gICAgdGhpcy50aW1lb3V0KDQwMDAwKVxuICAgIDtbYWxpY2VdID0gYXdhaXQgZXRoZXJzLmdldFNpZ25lcnMoKVxuXG4gICAgLy8gTWFrZSBhIGR1bW15IGNhbGwgdG8gdGhlIEFQSSB0byBnZXQgYSBibG9jayBudW1iZXIgdG8gZm9yayBmcm9tLlxuICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RDJyxcbiAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEVCcsXG4gICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICBhbW91bnQ6IGF3YWl0IGdldEFtb3VudCgxLCAnZXhhY3RJbicsICdVU0RDJywgJ1VTRFQnLCAnMTAwJyksXG4gICAgICB0eXBlOiAnZXhhY3RJbicsXG4gICAgfVxuXG4gICAgY29uc3Qge1xuICAgICAgZGF0YTogeyBibG9ja051bWJlciB9LFxuICAgIH0gPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3FzLnN0cmluZ2lmeShxdW90ZVJlcSl9YClcblxuICAgIGJsb2NrID0gcGFyc2VJbnQoYmxvY2tOdW1iZXIpIC0gMTBcblxuICAgIGFsaWNlID0gYXdhaXQgcmVzZXRBbmRGdW5kQXRCbG9jayhhbGljZSwgYmxvY2ssIFtcbiAgICAgIHBhcnNlQW1vdW50KCc4MDAwMDAwJywgVVNEQ19NQUlOTkVUKSxcbiAgICAgIHBhcnNlQW1vdW50KCc1MDAwMDAwJywgVVNEVF9NQUlOTkVUKSxcbiAgICAgIHBhcnNlQW1vdW50KCcxMCcsIFdCVENfTUFJTk5FVCksXG4gICAgICBwYXJzZUFtb3VudCgnMTAwMCcsIFVOSV9NQUlOTkVUKSxcbiAgICAgIHBhcnNlQW1vdW50KCc0MDAwJywgV0VUSDlbMV0pLFxuICAgICAgcGFyc2VBbW91bnQoJzUwMDAwMDAnLCBEQUlfTUFJTk5FVCksXG4gICAgICBwYXJzZUFtb3VudCgnNzM1ODcxJywgQlVMTEVUKSxcbiAgICBdKVxuXG4gICAgLy8gYWxpY2Ugc2hvdWxkIGFsd2F5cyBoYXZlIDEwMDAwIEVUSFxuICAgIGNvbnN0IGFsaWNlRXRoQmFsYW5jZSA9IGF3YWl0IGdldEJhbGFuY2UoYWxpY2UsIEV0aGVyLm9uQ2hhaW4oMSkpXG4gICAgLy8vIFNpbmNlIGFsaWNlIGlzIGRlcGxveWluZyB0aGUgUXVvdGVyVjMgY29udHJhY3QsIGV4cGVjdCB0byBoYXZlIHNsaWdodGx5IGxlc3MgdGhhbiAxMF8wMDAgRVRIIGJ1dCBub3QgdG9vIGxpdHRsZVxuICAgIGV4cGVjdCghYWxpY2VFdGhCYWxhbmNlLmxlc3NUaGFuKEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoRXRoZXIub25DaGFpbigxKSwgJzk5OTUnKSkpLnRvLmJlLnRydWVcblxuICAgIC8vIGZvciBhbGwgb3RoZXIgYmFsYW5jZSBjaGVja3MsIHdlIGVuc3VyZSB0aGV5IGFyZSBhdCBsZWFzdCBYIGFtb3VudC4gVGhlcmUncyBhIHBvc3NpYmlsaXR5IGZvciBtb3JlIHRoYW4gWCB0b2tlbiBhbW91bnQsXG4gICAgLy8gZHVlIHRvIGEgc2luZ2xlIHdoYWxlIGFkZHJlc3MgYmVpbmcgd2hhbGUgZm9yIG1vcmUgdGhhbiBvbmUgdG9rZW4uXG4gICAgY29uc3QgYWxpY2VVU0RDQmFsYW5jZSA9IGF3YWl0IGdldEJhbGFuY2UoYWxpY2UsIFVTRENfTUFJTk5FVClcbiAgICBleHBlY3QoIWFsaWNlVVNEQ0JhbGFuY2UubGVzc1RoYW4ocGFyc2VBbW91bnQoJzgwMDAwMDAnLCBVU0RDX01BSU5ORVQpKSkudG8uYmUudHJ1ZVxuICAgIGNvbnN0IGFsaWNlVVNEVEJhbGFuY2UgPSBhd2FpdCBnZXRCYWxhbmNlKGFsaWNlLCBVU0RUX01BSU5ORVQpXG4gICAgZXhwZWN0KCFhbGljZVVTRFRCYWxhbmNlLmxlc3NUaGFuKHBhcnNlQW1vdW50KCc1MDAwMDAwJywgVVNEVF9NQUlOTkVUKSkpLnRvLmJlLnRydWVcbiAgICBjb25zdCBhbGljZVdFVEg5QmFsYW5jZSA9IGF3YWl0IGdldEJhbGFuY2UoYWxpY2UsIFdFVEg5WzFdKVxuICAgIGV4cGVjdCghYWxpY2VXRVRIOUJhbGFuY2UubGVzc1RoYW4ocGFyc2VBbW91bnQoJzQwMDAnLCBXRVRIOVsxXSkpKS50by5iZS50cnVlXG4gICAgY29uc3QgYWxpY2VXQlRDQmFsYW5jZSA9IGF3YWl0IGdldEJhbGFuY2UoYWxpY2UsIFdCVENfTUFJTk5FVClcbiAgICBleHBlY3QoIWFsaWNlV0JUQ0JhbGFuY2UubGVzc1RoYW4ocGFyc2VBbW91bnQoJzEwJywgV0JUQ19NQUlOTkVUKSkpLnRvLmJlLnRydWVcbiAgICBjb25zdCBhbGljZURBSUJhbGFuY2UgPSBhd2FpdCBnZXRCYWxhbmNlKGFsaWNlLCBEQUlfTUFJTk5FVClcbiAgICBleHBlY3QoIWFsaWNlREFJQmFsYW5jZS5sZXNzVGhhbihwYXJzZUFtb3VudCgnNTAwMDAwMCcsIERBSV9NQUlOTkVUKSkpLnRvLmJlLnRydWVcbiAgICBjb25zdCBhbGljZVVOSUJhbGFuY2UgPSBhd2FpdCBnZXRCYWxhbmNlKGFsaWNlLCBVTklfTUFJTk5FVClcbiAgICBleHBlY3QoIWFsaWNlVU5JQmFsYW5jZS5sZXNzVGhhbihwYXJzZUFtb3VudCgnMTAwMCcsIFVOSV9NQUlOTkVUKSkpLnRvLmJlLnRydWVcbiAgICBjb25zdCBhbGljZUJVTExFVEJhbGFuY2UgPSBhd2FpdCBnZXRCYWxhbmNlKGFsaWNlLCBCVUxMRVQpXG4gICAgZXhwZWN0KCFhbGljZUJVTExFVEJhbGFuY2UubGVzc1RoYW4ocGFyc2VBbW91bnQoJzczNTg3MScsIEJVTExFVCkpKS50by5iZS50cnVlXG4gIH0pXG5cbiAgZm9yIChjb25zdCBhbGdvcml0aG0gb2YgWydhbHBoYSddKSB7XG4gICAgZm9yIChjb25zdCB0eXBlIG9mIFsnZXhhY3RJbicsICdleGFjdE91dCddKSB7XG4gICAgICBkZXNjcmliZShgJHtJRF9UT19ORVRXT1JLX05BTUUoMSl9ICR7YWxnb3JpdGhtfSAke3R5cGV9IDJ4eGAsICgpID0+IHtcbiAgICAgICAgZGVzY3JpYmUoYCsgRXhlY3V0ZSBTd2FwYCwgKCkgPT4ge1xuICAgICAgICAgIGl0KGBlcmMyMCAtPiBlcmMyMGAsIGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ1VTREMnLFxuICAgICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEVCcsXG4gICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgYW1vdW50OiBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ1VTREMnLCAnVVNEVCcsICcxMDAnKSxcbiAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgICBzbGlwcGFnZVRvbGVyYW5jZTogU0xJUFBBR0UsXG4gICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IHRydWUsXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgICBjb25zdCByZXNwb25zZTogQXhpb3NSZXNwb25zZTxRdW90ZVJlc3BvbnNlPiA9IGF3YWl0IGF4aW9zLmdldDxRdW90ZVJlc3BvbnNlPihgJHtBUEl9PyR7cXVlcnlQYXJhbXN9YClcbiAgICAgICAgICAgIGNvbnN0IHtcbiAgICAgICAgICAgICAgZGF0YTogeyBxdW90ZSwgcXVvdGVEZWNpbWFscywgcXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzLCBtZXRob2RQYXJhbWV0ZXJzIH0sXG4gICAgICAgICAgICAgIHN0YXR1cyxcbiAgICAgICAgICAgIH0gPSByZXNwb25zZVxuXG4gICAgICAgICAgICBleHBlY3Qoc3RhdHVzKS50by5lcXVhbCgyMDApXG4gICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW4oOTApXG4gICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSkudG8uYmUubGVzc1RoYW4oMTEwKVxuXG4gICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUubGVzc1RoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZXhwZWN0KG1ldGhvZFBhcmFtZXRlcnMpLnRvLm5vdC5iZS51bmRlZmluZWRcbiAgICAgICAgICAgIGV4cGVjdChtZXRob2RQYXJhbWV0ZXJzPy50bykudG8uZXF1YWwoVU5JVkVSU0FMX1JPVVRFUl9BRERSRVNTKVxuXG4gICAgICAgICAgICBjb25zdCB7IHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgdG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIgfSA9IGF3YWl0IGV4ZWN1dGVTd2FwKFxuICAgICAgICAgICAgICBtZXRob2RQYXJhbWV0ZXJzISxcbiAgICAgICAgICAgICAgVVNEQ19NQUlOTkVULFxuICAgICAgICAgICAgICBVU0RUX01BSU5ORVRcbiAgICAgICAgICAgIClcblxuICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgIGV4cGVjdCh0b2tlbkluQmVmb3JlLnN1YnRyYWN0KHRva2VuSW5BZnRlcikudG9FeGFjdCgpKS50by5lcXVhbCgnMTAwJylcbiAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KFVTRFRfTUFJTk5FVCwgcXVvdGUpKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgZXhwZWN0KHRva2VuT3V0QWZ0ZXIuc3VidHJhY3QodG9rZW5PdXRCZWZvcmUpLnRvRXhhY3QoKSkudG8uZXF1YWwoJzEwMCcpXG4gICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoVVNEQ19NQUlOTkVULCBxdW90ZSkpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSlcblxuICAgICAgICAgIGl0KGBlcmMyMCAtPiBlcmMyMCBzd2Fwcm91dGVyMDJgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RDJyxcbiAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ1VTRFQnLFxuICAgICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RDJywgJ1VTRFQnLCAnMTAwJyksXG4gICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlOiBBeGlvc1Jlc3BvbnNlPFF1b3RlUmVzcG9uc2U+ID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgY29uc3Qge1xuICAgICAgICAgICAgICBkYXRhOiB7IHF1b3RlLCBxdW90ZURlY2ltYWxzLCBxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMsIG1ldGhvZFBhcmFtZXRlcnMgfSxcbiAgICAgICAgICAgICAgc3RhdHVzLFxuICAgICAgICAgICAgfSA9IHJlc3BvbnNlXG5cbiAgICAgICAgICAgIGV4cGVjdChzdGF0dXMpLnRvLmVxdWFsKDIwMClcbiAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbig5MClcbiAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbigxMTApXG5cbiAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscykpLnRvLmJlLmdyZWF0ZXJUaGFuT3JFcXVhbChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBleHBlY3QobWV0aG9kUGFyYW1ldGVycykudG8ubm90LmJlLnVuZGVmaW5lZFxuICAgICAgICAgICAgZXhwZWN0KG1ldGhvZFBhcmFtZXRlcnM/LnRvKS50by5lcXVhbChTV0FQX1JPVVRFUl8wMl9BRERSRVNTRVMoQ2hhaW5JZC5NQUlOTkVUKSlcblxuICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgbWV0aG9kUGFyYW1ldGVycyEsXG4gICAgICAgICAgICAgIFVTRENfTUFJTk5FVCxcbiAgICAgICAgICAgICAgVVNEVF9NQUlOTkVUXG4gICAgICAgICAgICApXG5cbiAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICBleHBlY3QodG9rZW5JbkJlZm9yZS5zdWJ0cmFjdCh0b2tlbkluQWZ0ZXIpLnRvRXhhY3QoKSkudG8uZXF1YWwoJzEwMCcpXG4gICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChVU0RUX01BSU5ORVQsIHF1b3RlKSlcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGV4cGVjdCh0b2tlbk91dEFmdGVyLnN1YnRyYWN0KHRva2VuT3V0QmVmb3JlKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAnKVxuICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5JbkJlZm9yZSwgdG9rZW5JbkFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KFVTRENfTUFJTk5FVCwgcXVvdGUpKVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pXG5cbiAgICAgICAgICBpdChgZXJjMjAgLT4gZXJjMjAgd2l0aCBwZXJtaXRgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBhbW91bnQgPSBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ1VTREMnLCAnVVNEVCcsICcxMCcpXG5cbiAgICAgICAgICAgIGNvbnN0IG5vbmNlID0gbmV4dFBlcm1pdE5vbmNlKClcblxuICAgICAgICAgICAgY29uc3QgcGVybWl0OiBQZXJtaXRTaW5nbGUgPSB7XG4gICAgICAgICAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgICAgICAgICB0b2tlbjogVVNEQ19NQUlOTkVULmFkZHJlc3MsXG4gICAgICAgICAgICAgICAgYW1vdW50OiAnMTUwMDAwMDAnLCAvLyBGb3IgZXhhY3Qgb3V0IHdlIGRvbid0IGtub3cgdGhlIGV4YWN0IGFtb3VudCBuZWVkZWQgdG8gcGVybWl0LCBzbyBqdXN0IHNwZWNpZnkgYSBsYXJnZSBhbW91bnQuXG4gICAgICAgICAgICAgICAgZXhwaXJhdGlvbjogTWF0aC5mbG9vcihuZXcgRGF0ZSgpLmdldFRpbWUoKSAvIDEwMDAgKyAxMDAwMDAwMCkudG9TdHJpbmcoKSxcbiAgICAgICAgICAgICAgICBub25jZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgc3BlbmRlcjogVU5JVkVSU0FMX1JPVVRFUl9BRERSRVNTLFxuICAgICAgICAgICAgICBzaWdEZWFkbGluZTogTWF0aC5mbG9vcihuZXcgRGF0ZSgpLmdldFRpbWUoKSAvIDEwMDAgKyAxMDAwMDAwMCkudG9TdHJpbmcoKSxcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgeyBkb21haW4sIHR5cGVzLCB2YWx1ZXMgfSA9IEFsbG93YW5jZVRyYW5zZmVyLmdldFBlcm1pdERhdGEocGVybWl0LCBQRVJNSVQyX0FERFJFU1MsIDEpXG5cbiAgICAgICAgICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IGFsaWNlLl9zaWduVHlwZWREYXRhKGRvbWFpbiwgdHlwZXMsIHZhbHVlcylcblxuICAgICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiAnVVNEQycsXG4gICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6ICdVU0RUJyxcbiAgICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiAxLFxuICAgICAgICAgICAgICBhbW91bnQsXG4gICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgICAgcGVybWl0U2lnbmF0dXJlOiBzaWduYXR1cmUsXG4gICAgICAgICAgICAgIHBlcm1pdEFtb3VudDogcGVybWl0LmRldGFpbHMuYW1vdW50LnRvU3RyaW5nKCksXG4gICAgICAgICAgICAgIHBlcm1pdEV4cGlyYXRpb246IHBlcm1pdC5kZXRhaWxzLmV4cGlyYXRpb24udG9TdHJpbmcoKSxcbiAgICAgICAgICAgICAgcGVybWl0U2lnRGVhZGxpbmU6IHBlcm1pdC5zaWdEZWFkbGluZS50b1N0cmluZygpLFxuICAgICAgICAgICAgICBwZXJtaXROb25jZTogcGVybWl0LmRldGFpbHMubm9uY2UudG9TdHJpbmcoKSxcbiAgICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHFzLnN0cmluZ2lmeShxdW90ZVJlcSlcblxuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2U6IEF4aW9zUmVzcG9uc2U8UXVvdGVSZXNwb25zZT4gPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICAgIGRhdGE6IHsgcXVvdGUsIHF1b3RlRGVjaW1hbHMsIHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscywgbWV0aG9kUGFyYW1ldGVycyB9LFxuICAgICAgICAgICAgICBzdGF0dXMsXG4gICAgICAgICAgICB9ID0gcmVzcG9uc2VcblxuICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpLnRvLmJlLmdyZWF0ZXJUaGFuKDkpXG4gICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSkudG8uYmUubGVzc1RoYW4oMTEpXG5cbiAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscykpLnRvLmJlLmdyZWF0ZXJUaGFuT3JFcXVhbChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBleHBlY3QobWV0aG9kUGFyYW1ldGVycykudG8ubm90LmJlLnVuZGVmaW5lZFxuICAgICAgICAgICAgZXhwZWN0KG1ldGhvZFBhcmFtZXRlcnM/LnRvKS50by5lcXVhbChVTklWRVJTQUxfUk9VVEVSX0FERFJFU1MpXG5cbiAgICAgICAgICAgIGNvbnN0IHsgdG9rZW5JbkJlZm9yZSwgdG9rZW5JbkFmdGVyLCB0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciB9ID0gYXdhaXQgZXhlY3V0ZVN3YXAoXG4gICAgICAgICAgICAgIG1ldGhvZFBhcmFtZXRlcnMhLFxuICAgICAgICAgICAgICBVU0RDX01BSU5ORVQsXG4gICAgICAgICAgICAgIFVTRFRfTUFJTk5FVCxcbiAgICAgICAgICAgICAgdHJ1ZVxuICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgZXhwZWN0KHRva2VuSW5CZWZvcmUuc3VidHJhY3QodG9rZW5JbkFmdGVyKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMCcpXG4gICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChVU0RUX01BSU5ORVQsIHF1b3RlKSlcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGV4cGVjdCh0b2tlbk91dEFmdGVyLnN1YnRyYWN0KHRva2VuT3V0QmVmb3JlKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMCcpXG4gICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoVVNEQ19NQUlOTkVULCBxdW90ZSkpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSlcblxuICAgICAgICAgIGl0KGBlcmMyMCAtPiBldGhgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RDJyxcbiAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ0VUSCcsXG4gICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgYW1vdW50OiBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ1VTREMnLCAnRVRIJywgdHlwZSA9PSAnZXhhY3RJbicgPyAnMTAwMDAwMCcgOiAnMTAnKSxcbiAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgICBzbGlwcGFnZVRvbGVyYW5jZTogU0xJUFBBR0UsXG4gICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IHRydWUsXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGF4aW9zLmdldDxRdW90ZVJlc3BvbnNlPihgJHtBUEl9PyR7cXVlcnlQYXJhbXN9YClcbiAgICAgICAgICAgIGNvbnN0IHtcbiAgICAgICAgICAgICAgZGF0YTogeyBxdW90ZSwgbWV0aG9kUGFyYW1ldGVycyB9LFxuICAgICAgICAgICAgICBzdGF0dXMsXG4gICAgICAgICAgICB9ID0gcmVzcG9uc2VcblxuICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgICAgZXhwZWN0KG1ldGhvZFBhcmFtZXRlcnMpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgbWV0aG9kUGFyYW1ldGVycyEsXG4gICAgICAgICAgICAgIFVTRENfTUFJTk5FVCxcbiAgICAgICAgICAgICAgRXRoZXIub25DaGFpbigxKVxuICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgZXhwZWN0KHRva2VuSW5CZWZvcmUuc3VidHJhY3QodG9rZW5JbkFmdGVyKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAwMDAwJylcbiAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KEV0aGVyLm9uQ2hhaW4oMSksIHF1b3RlKSlcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIC8vIEhhcmQgdG8gdGVzdCBFVEggYmFsYW5jZSBkdWUgdG8gZ2FzIGNvc3RzIGZvciBhcHByb3ZhbCBhbmQgc3dhcC4gSnVzdCBjaGVjayB0b2tlbkluIGNoYW5nZXNcbiAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChVU0RDX01BSU5ORVQsIHF1b3RlKSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuXG4gICAgICAgICAgaXQoYGVyYzIwIC0+IGV0aCBsYXJnZSB0cmFkZWAsIGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIC8vIFRyYWRlIG9mIHRoaXMgc2l6ZSBhbG1vc3QgYWx3YXlzIHJlc3VsdHMgaW4gc3BsaXRzLlxuICAgICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiAnVVNEQycsXG4gICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6ICdFVEgnLFxuICAgICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICAgIGFtb3VudDpcbiAgICAgICAgICAgICAgICB0eXBlID09ICdleGFjdEluJ1xuICAgICAgICAgICAgICAgICAgPyBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ1VTREMnLCAnRVRIJywgJzEwMDAwMDAnKVxuICAgICAgICAgICAgICAgICAgOiBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ1VTREMnLCAnRVRIJywgJzEwMCcpLFxuICAgICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgICByZWNpcGllbnQ6IGFsaWNlLmFkZHJlc3MsXG4gICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgICBhbGdvcml0aG0sXG4gICAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgY29uc3QgeyBkYXRhLCBzdGF0dXMgfSA9IHJlc3BvbnNlXG5cbiAgICAgICAgICAgIGV4cGVjdChzdGF0dXMpLnRvLmVxdWFsKDIwMClcbiAgICAgICAgICAgIGV4cGVjdChkYXRhLm1ldGhvZFBhcmFtZXRlcnMpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgZXhwZWN0KGRhdGEucm91dGUpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgY29uc3QgYW1vdW50SW5FZGdlc1RvdGFsID0gXyhkYXRhLnJvdXRlKVxuICAgICAgICAgICAgICAuZmxhdE1hcCgocm91dGUpID0+IHJvdXRlWzBdISlcbiAgICAgICAgICAgICAgLmZpbHRlcigocG9vbCkgPT4gISFwb29sLmFtb3VudEluKVxuICAgICAgICAgICAgICAubWFwKChwb29sKSA9PiBCaWdOdW1iZXIuZnJvbShwb29sLmFtb3VudEluKSlcbiAgICAgICAgICAgICAgLnJlZHVjZSgoY3VyLCB0b3RhbCkgPT4gdG90YWwuYWRkKGN1ciksIEJpZ051bWJlci5mcm9tKDApKVxuICAgICAgICAgICAgY29uc3QgYW1vdW50SW4gPSBCaWdOdW1iZXIuZnJvbShkYXRhLnF1b3RlKVxuICAgICAgICAgICAgZXhwZWN0KGFtb3VudEluLmVxKGFtb3VudEluRWRnZXNUb3RhbCkpXG5cbiAgICAgICAgICAgIGNvbnN0IGFtb3VudE91dEVkZ2VzVG90YWwgPSBfKGRhdGEucm91dGUpXG4gICAgICAgICAgICAgIC5mbGF0TWFwKChyb3V0ZSkgPT4gcm91dGVbMF0hKVxuICAgICAgICAgICAgICAuZmlsdGVyKChwb29sKSA9PiAhIXBvb2wuYW1vdW50T3V0KVxuICAgICAgICAgICAgICAubWFwKChwb29sKSA9PiBCaWdOdW1iZXIuZnJvbShwb29sLmFtb3VudE91dCkpXG4gICAgICAgICAgICAgIC5yZWR1Y2UoKGN1ciwgdG90YWwpID0+IHRvdGFsLmFkZChjdXIpLCBCaWdOdW1iZXIuZnJvbSgwKSlcbiAgICAgICAgICAgIGNvbnN0IGFtb3VudE91dCA9IEJpZ051bWJlci5mcm9tKGRhdGEucXVvdGUpXG4gICAgICAgICAgICBleHBlY3QoYW1vdW50T3V0LmVxKGFtb3VudE91dEVkZ2VzVG90YWwpKVxuXG4gICAgICAgICAgICBjb25zdCB7IHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgdG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIgfSA9IGF3YWl0IGV4ZWN1dGVTd2FwKFxuICAgICAgICAgICAgICBkYXRhLm1ldGhvZFBhcmFtZXRlcnMhLFxuICAgICAgICAgICAgICBVU0RDX01BSU5ORVQsXG4gICAgICAgICAgICAgIEV0aGVyLm9uQ2hhaW4oMSlcbiAgICAgICAgICAgIClcblxuICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgIGV4cGVjdCh0b2tlbkluQmVmb3JlLnN1YnRyYWN0KHRva2VuSW5BZnRlcikudG9FeGFjdCgpKS50by5lcXVhbCgnMTAwMDAwMCcpXG4gICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChFdGhlci5vbkNoYWluKDEpLCBkYXRhLnF1b3RlKSlcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIC8vIEhhcmQgdG8gdGVzdCBFVEggYmFsYW5jZSBkdWUgdG8gZ2FzIGNvc3RzIGZvciBhcHByb3ZhbCBhbmQgc3dhcC4gSnVzdCBjaGVjayB0b2tlbkluIGNoYW5nZXNcbiAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChVU0RDX01BSU5ORVQsIGRhdGEucXVvdGUpKVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pXG5cbiAgICAgICAgICBpdChgZXJjMjAgLT4gZXRoIGxhcmdlIHRyYWRlIHdpdGggcGVybWl0YCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgY29uc3Qgbm9uY2UgPSBuZXh0UGVybWl0Tm9uY2UoKVxuXG4gICAgICAgICAgICBjb25zdCBhbW91bnQgPVxuICAgICAgICAgICAgICB0eXBlID09ICdleGFjdEluJ1xuICAgICAgICAgICAgICAgID8gYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RDJywgJ0VUSCcsICcxMDAwMDAwJylcbiAgICAgICAgICAgICAgICA6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnVVNEQycsICdFVEgnLCAnMTAwJylcblxuICAgICAgICAgICAgY29uc3QgcGVybWl0OiBQZXJtaXRTaW5nbGUgPSB7XG4gICAgICAgICAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgICAgICAgICB0b2tlbjogVVNEQ19NQUlOTkVULmFkZHJlc3MsXG4gICAgICAgICAgICAgICAgYW1vdW50OiAnMTUwMDAwMDAwMDAwMCcsIC8vIEZvciBleGFjdCBvdXQgd2UgZG9uJ3Qga25vdyB0aGUgZXhhY3QgYW1vdW50IG5lZWRlZCB0byBwZXJtaXQsIHNvIGp1c3Qgc3BlY2lmeSBhIGxhcmdlIGFtb3VudC5cbiAgICAgICAgICAgICAgICBleHBpcmF0aW9uOiBNYXRoLmZsb29yKG5ldyBEYXRlKCkuZ2V0VGltZSgpIC8gMTAwMCArIDEwMDAwMDAwKS50b1N0cmluZygpLFxuICAgICAgICAgICAgICAgIG5vbmNlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBzcGVuZGVyOiBVTklWRVJTQUxfUk9VVEVSX0FERFJFU1MsXG4gICAgICAgICAgICAgIHNpZ0RlYWRsaW5lOiBNYXRoLmZsb29yKG5ldyBEYXRlKCkuZ2V0VGltZSgpIC8gMTAwMCArIDEwMDAwMDAwKS50b1N0cmluZygpLFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCB7IGRvbWFpbiwgdHlwZXMsIHZhbHVlcyB9ID0gQWxsb3dhbmNlVHJhbnNmZXIuZ2V0UGVybWl0RGF0YShwZXJtaXQsIFBFUk1JVDJfQUREUkVTUywgMSlcblxuICAgICAgICAgICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgYWxpY2UuX3NpZ25UeXBlZERhdGEoZG9tYWluLCB0eXBlcywgdmFsdWVzKVxuXG4gICAgICAgICAgICAvLyBUcmFkZSBvZiB0aGlzIHNpemUgYWxtb3N0IGFsd2F5cyByZXN1bHRzIGluIHNwbGl0cy5cbiAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ1VTREMnLFxuICAgICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnRVRIJyxcbiAgICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiAxLFxuICAgICAgICAgICAgICBhbW91bnQsXG4gICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgICAgcGVybWl0U2lnbmF0dXJlOiBzaWduYXR1cmUsXG4gICAgICAgICAgICAgIHBlcm1pdEFtb3VudDogcGVybWl0LmRldGFpbHMuYW1vdW50LnRvU3RyaW5nKCksXG4gICAgICAgICAgICAgIHBlcm1pdEV4cGlyYXRpb246IHBlcm1pdC5kZXRhaWxzLmV4cGlyYXRpb24udG9TdHJpbmcoKSxcbiAgICAgICAgICAgICAgcGVybWl0U2lnRGVhZGxpbmU6IHBlcm1pdC5zaWdEZWFkbGluZS50b1N0cmluZygpLFxuICAgICAgICAgICAgICBwZXJtaXROb25jZTogcGVybWl0LmRldGFpbHMubm9uY2UudG9TdHJpbmcoKSxcbiAgICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHFzLnN0cmluZ2lmeShxdW90ZVJlcSlcblxuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgICAgICAgICBjb25zdCB7IGRhdGEsIHN0YXR1cyB9ID0gcmVzcG9uc2VcblxuICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgICAgZXhwZWN0KGRhdGEubWV0aG9kUGFyYW1ldGVycykudG8ubm90LmJlLnVuZGVmaW5lZFxuICAgICAgICAgICAgZXhwZWN0KGRhdGEucm91dGUpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgZGF0YS5tZXRob2RQYXJhbWV0ZXJzISxcbiAgICAgICAgICAgICAgVVNEQ19NQUlOTkVULFxuICAgICAgICAgICAgICBFdGhlci5vbkNoYWluKDEpLFxuICAgICAgICAgICAgICB0cnVlXG4gICAgICAgICAgICApXG5cbiAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICBleHBlY3QodG9rZW5JbkJlZm9yZS5zdWJ0cmFjdCh0b2tlbkluQWZ0ZXIpLnRvRXhhY3QoKSkudG8uZXF1YWwoJzEwMDAwMDAnKVxuICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoRXRoZXIub25DaGFpbigxKSwgZGF0YS5xdW90ZSkpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBIYXJkIHRvIHRlc3QgRVRIIGJhbGFuY2UgZHVlIHRvIGdhcyBjb3N0cyBmb3IgYXBwcm92YWwgYW5kIHN3YXAuIEp1c3QgY2hlY2sgdG9rZW5JbiBjaGFuZ2VzXG4gICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoVVNEQ19NQUlOTkVULCBkYXRhLnF1b3RlKSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuXG4gICAgICAgICAgaXQoYGV0aCAtPiBlcmMyMGAsIGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ0VUSCcsXG4gICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6ICdVTkknLFxuICAgICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICAgIGFtb3VudDpcbiAgICAgICAgICAgICAgICB0eXBlID09ICdleGFjdEluJ1xuICAgICAgICAgICAgICAgICAgPyBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ0VUSCcsICdVTkknLCAnMTAnKVxuICAgICAgICAgICAgICAgICAgOiBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ0VUSCcsICdVTkknLCAnMTAwMDAnKSxcbiAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgICBzbGlwcGFnZVRvbGVyYW5jZTogU0xJUFBBR0UsXG4gICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IHRydWUsXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGF4aW9zLmdldDxRdW90ZVJlc3BvbnNlPihgJHtBUEl9PyR7cXVlcnlQYXJhbXN9YClcbiAgICAgICAgICAgIGNvbnN0IHsgZGF0YSwgc3RhdHVzIH0gPSByZXNwb25zZVxuXG4gICAgICAgICAgICBleHBlY3Qoc3RhdHVzKS50by5lcXVhbCgyMDApXG4gICAgICAgICAgICBleHBlY3QoZGF0YS5tZXRob2RQYXJhbWV0ZXJzKS50by5ub3QuYmUudW5kZWZpbmVkXG5cbiAgICAgICAgICAgIGNvbnN0IHsgdG9rZW5JbkJlZm9yZSwgdG9rZW5JbkFmdGVyLCB0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciB9ID0gYXdhaXQgZXhlY3V0ZVN3YXAoXG4gICAgICAgICAgICAgIGRhdGEubWV0aG9kUGFyYW1ldGVycyEsXG4gICAgICAgICAgICAgIEV0aGVyLm9uQ2hhaW4oMSksXG4gICAgICAgICAgICAgIFVOSV9NQUlOTkVUXG4gICAgICAgICAgICApXG5cbiAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICAvLyBXZSd2ZSBzd2FwcGVkIDEwIEVUSCArIGdhcyBjb3N0c1xuICAgICAgICAgICAgICBleHBlY3QodG9rZW5JbkJlZm9yZS5zdWJ0cmFjdCh0b2tlbkluQWZ0ZXIpLmdyZWF0ZXJUaGFuKHBhcnNlQW1vdW50KCcxMCcsIEV0aGVyLm9uQ2hhaW4oMSkpKSkudG8uYmUudHJ1ZVxuICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoVU5JX01BSU5ORVQsIGRhdGEucXVvdGUpKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgZXhwZWN0KHRva2VuT3V0QWZ0ZXIuc3VidHJhY3QodG9rZW5PdXRCZWZvcmUpLnRvRXhhY3QoKSkudG8uZXF1YWwoJzEwMDAwJylcbiAgICAgICAgICAgICAgLy8gQ2FuJ3QgZWFzaWx5IGNoZWNrIHNsaXBwYWdlIGZvciBFVEggZHVlIHRvIGdhcyBjb3N0cyBlZmZlY3RpbmcgRVRIIGJhbGFuY2UuXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSlcblxuICAgICAgICAgIGl0KGBldGggLT4gZXJjMjAgc3dhcHJvdXRlcjAyYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiAnRVRIJyxcbiAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ1VOSScsXG4gICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgYW1vdW50OlxuICAgICAgICAgICAgICAgIHR5cGUgPT0gJ2V4YWN0SW4nXG4gICAgICAgICAgICAgICAgICA/IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnRVRIJywgJ1VOSScsICcxMCcpXG4gICAgICAgICAgICAgICAgICA6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnRVRIJywgJ1VOSScsICcxMDAwMCcpLFxuICAgICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgICByZWNpcGllbnQ6IGFsaWNlLmFkZHJlc3MsXG4gICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiB0eXBlID09ICdleGFjdE91dCcgPyBMQVJHRV9TTElQUEFHRSA6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiBmYWxzZSxcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgY29uc3QgeyBkYXRhLCBzdGF0dXMgfSA9IHJlc3BvbnNlXG5cbiAgICAgICAgICAgIGV4cGVjdChzdGF0dXMpLnRvLmVxdWFsKDIwMClcbiAgICAgICAgICAgIGV4cGVjdChkYXRhLm1ldGhvZFBhcmFtZXRlcnMpLnRvLm5vdC5iZS51bmRlZmluZWRcbiAgICAgICAgICAgIGV4cGVjdChkYXRhLm1ldGhvZFBhcmFtZXRlcnM/LnRvKS50by5lcXVhbChTV0FQX1JPVVRFUl8wMl9BRERSRVNTRVMoQ2hhaW5JZC5NQUlOTkVUKSlcblxuICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgZGF0YS5tZXRob2RQYXJhbWV0ZXJzISxcbiAgICAgICAgICAgICAgRXRoZXIub25DaGFpbigxKSxcbiAgICAgICAgICAgICAgVU5JX01BSU5ORVRcbiAgICAgICAgICAgIClcblxuICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgIC8vIFdlJ3ZlIHN3YXBwZWQgMTAgRVRIICsgZ2FzIGNvc3RzXG4gICAgICAgICAgICAgIGV4cGVjdCh0b2tlbkluQmVmb3JlLnN1YnRyYWN0KHRva2VuSW5BZnRlcikuZ3JlYXRlclRoYW4ocGFyc2VBbW91bnQoJzEwJywgRXRoZXIub25DaGFpbigxKSkpKS50by5iZS50cnVlXG4gICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChVTklfTUFJTk5FVCwgZGF0YS5xdW90ZSkpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBleHBlY3QodG9rZW5PdXRBZnRlci5zdWJ0cmFjdCh0b2tlbk91dEJlZm9yZSkudG9FeGFjdCgpKS50by5lcXVhbCgnMTAwMDAnKVxuICAgICAgICAgICAgICAvLyBDYW4ndCBlYXNpbHkgY2hlY2sgc2xpcHBhZ2UgZm9yIEVUSCBkdWUgdG8gZ2FzIGNvc3RzIGVmZmVjdGluZyBFVEggYmFsYW5jZS5cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuXG4gICAgICAgICAgaXQoYHdldGggLT4gZXJjMjBgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdXRVRIJyxcbiAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ0RBSScsXG4gICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgYW1vdW50OiBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ1dFVEgnLCAnREFJJywgJzEwMCcpLFxuICAgICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgICByZWNpcGllbnQ6IGFsaWNlLmFkZHJlc3MsXG4gICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgICBhbGdvcml0aG0sXG4gICAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgY29uc3QgeyBkYXRhLCBzdGF0dXMgfSA9IHJlc3BvbnNlXG5cbiAgICAgICAgICAgIGV4cGVjdChzdGF0dXMpLnRvLmVxdWFsKDIwMClcbiAgICAgICAgICAgIGV4cGVjdChkYXRhLm1ldGhvZFBhcmFtZXRlcnMpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgZGF0YS5tZXRob2RQYXJhbWV0ZXJzISxcbiAgICAgICAgICAgICAgV0VUSDlbMV0hLFxuICAgICAgICAgICAgICBEQUlfTUFJTk5FVFxuICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgZXhwZWN0KHRva2VuSW5CZWZvcmUuc3VidHJhY3QodG9rZW5JbkFmdGVyKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAnKVxuICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoREFJX01BSU5ORVQsIGRhdGEucXVvdGUpKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgZXhwZWN0KHRva2VuT3V0QWZ0ZXIuc3VidHJhY3QodG9rZW5PdXRCZWZvcmUpLnRvRXhhY3QoKSkudG8uZXF1YWwoJzEwMCcpXG4gICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoV0VUSDlbMV0hLCBkYXRhLnF1b3RlKSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuXG4gICAgICAgICAgaXQoYGVyYzIwIC0+IHdldGhgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RDJyxcbiAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ1dFVEgnLFxuICAgICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RDJywgJ1dFVEgnLCAnMTAwJyksXG4gICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHFzLnN0cmluZ2lmeShxdW90ZVJlcSlcblxuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgICAgICAgICBjb25zdCB7IGRhdGEsIHN0YXR1cyB9ID0gcmVzcG9uc2VcblxuICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgICAgZXhwZWN0KGRhdGEubWV0aG9kUGFyYW1ldGVycykudG8ubm90LmJlLnVuZGVmaW5lZFxuXG4gICAgICAgICAgICBjb25zdCB7IHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgdG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIgfSA9IGF3YWl0IGV4ZWN1dGVTd2FwKFxuICAgICAgICAgICAgICBkYXRhLm1ldGhvZFBhcmFtZXRlcnMhLFxuICAgICAgICAgICAgICBVU0RDX01BSU5ORVQsXG4gICAgICAgICAgICAgIFdFVEg5WzFdIVxuICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgZXhwZWN0KHRva2VuSW5CZWZvcmUuc3VidHJhY3QodG9rZW5JbkFmdGVyKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAnKVxuICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoV0VUSDlbMV0sIGRhdGEucXVvdGUpKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgZXhwZWN0KHRva2VuT3V0QWZ0ZXIuc3VidHJhY3QodG9rZW5PdXRCZWZvcmUpLnRvRXhhY3QoKSkudG8uZXF1YWwoJzEwMCcpXG4gICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoVVNEQ19NQUlOTkVULCBkYXRhLnF1b3RlKSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuXG4gICAgICAgICAgaWYgKGFsZ29yaXRobSA9PSAnYWxwaGEnKSB7XG4gICAgICAgICAgICBpdChgZXJjMjAgLT4gZXJjMjAgdjMgb25seWAsIGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RDJyxcbiAgICAgICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6ICdVU0RUJyxcbiAgICAgICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICAgICAgYW1vdW50OiBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ1VTREMnLCAnVVNEVCcsICcxMDAnKSxcbiAgICAgICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgICAgICBzbGlwcGFnZVRvbGVyYW5jZTogU0xJUFBBR0UsXG4gICAgICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgICAgIGFsZ29yaXRobTogJ2FscGhhJyxcbiAgICAgICAgICAgICAgICBwcm90b2NvbHM6ICd2MycsXG4gICAgICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2U6IEF4aW9zUmVzcG9uc2U8UXVvdGVSZXNwb25zZT4gPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgICAgICAgICAgIGNvbnN0IHtcbiAgICAgICAgICAgICAgICBkYXRhOiB7IHF1b3RlLCBxdW90ZURlY2ltYWxzLCBxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMsIG1ldGhvZFBhcmFtZXRlcnMsIHJvdXRlIH0sXG4gICAgICAgICAgICAgICAgc3RhdHVzLFxuICAgICAgICAgICAgICB9ID0gcmVzcG9uc2VcblxuICAgICAgICAgICAgICBleHBlY3Qoc3RhdHVzKS50by5lcXVhbCgyMDApXG4gICAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbig5MClcbiAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpLnRvLmJlLmxlc3NUaGFuKDExMClcblxuICAgICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGV4cGVjdChtZXRob2RQYXJhbWV0ZXJzKS50by5ub3QuYmUudW5kZWZpbmVkXG5cbiAgICAgICAgICAgICAgZm9yIChjb25zdCByIG9mIHJvdXRlKSB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBwb29sIG9mIHIpIHtcbiAgICAgICAgICAgICAgICAgIGV4cGVjdChwb29sLnR5cGUpLnRvLmVxdWFsKCd2My1wb29sJylcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBjb25zdCB7IHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgdG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIgfSA9IGF3YWl0IGV4ZWN1dGVTd2FwKFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlLmRhdGEubWV0aG9kUGFyYW1ldGVycyEsXG4gICAgICAgICAgICAgICAgVVNEQ19NQUlOTkVULFxuICAgICAgICAgICAgICAgIFVTRFRfTUFJTk5FVCFcbiAgICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICAgIGV4cGVjdCh0b2tlbkluQmVmb3JlLnN1YnRyYWN0KHRva2VuSW5BZnRlcikudG9FeGFjdCgpKS50by5lcXVhbCgnMTAwJylcbiAgICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoVVNEVF9NQUlOTkVULCBxdW90ZSkpXG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXhwZWN0KHRva2VuT3V0QWZ0ZXIuc3VidHJhY3QodG9rZW5PdXRCZWZvcmUpLnRvRXhhY3QoKSkudG8uZXF1YWwoJzEwMCcpXG4gICAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChVU0RDX01BSU5ORVQsIHF1b3RlKSlcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSlcblxuICAgICAgICAgICAgaXQoYGVyYzIwIC0+IGVyYzIwIHYyIG9ubHlgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiAnVVNEQycsXG4gICAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEVCcsXG4gICAgICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RDJywgJ1VTRFQnLCAnMTAwJyksXG4gICAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgICByZWNpcGllbnQ6IGFsaWNlLmFkZHJlc3MsXG4gICAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgICBhbGdvcml0aG06ICdhbHBoYScsXG4gICAgICAgICAgICAgICAgcHJvdG9jb2xzOiAndjInLFxuICAgICAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlOiBBeGlvc1Jlc3BvbnNlPFF1b3RlUmVzcG9uc2U+ID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICAgICAgZGF0YTogeyBxdW90ZSwgcXVvdGVEZWNpbWFscywgcXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzLCBtZXRob2RQYXJhbWV0ZXJzLCByb3V0ZSB9LFxuICAgICAgICAgICAgICAgIHN0YXR1cyxcbiAgICAgICAgICAgICAgfSA9IHJlc3BvbnNlXG5cbiAgICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW4oOTApXG4gICAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbigxMTApXG5cbiAgICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUubGVzc1RoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBleHBlY3QobWV0aG9kUGFyYW1ldGVycykudG8ubm90LmJlLnVuZGVmaW5lZFxuXG4gICAgICAgICAgICAgIGZvciAoY29uc3QgciBvZiByb3V0ZSkge1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgcG9vbCBvZiByKSB7XG4gICAgICAgICAgICAgICAgICBleHBlY3QocG9vbC50eXBlKS50by5lcXVhbCgndjItcG9vbCcpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgICByZXNwb25zZS5kYXRhLm1ldGhvZFBhcmFtZXRlcnMhLFxuICAgICAgICAgICAgICAgIFVTRENfTUFJTk5FVCxcbiAgICAgICAgICAgICAgICBVU0RUX01BSU5ORVQhXG4gICAgICAgICAgICAgIClcblxuICAgICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgICBleHBlY3QodG9rZW5JbkJlZm9yZS5zdWJ0cmFjdCh0b2tlbkluQWZ0ZXIpLnRvRXhhY3QoKSkudG8uZXF1YWwoJzEwMCcpXG4gICAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KFVTRFRfTUFJTk5FVCwgcXVvdGUpKVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGV4cGVjdCh0b2tlbk91dEFmdGVyLnN1YnRyYWN0KHRva2VuT3V0QmVmb3JlKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAnKVxuICAgICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoVVNEQ19NQUlOTkVULCBxdW90ZSkpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgIGl0KGBlcmMyMCAtPiBlcmMyMCBmb3JjZUNyb3NzUHJvdG9jb2xgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiAnVVNEQycsXG4gICAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEVCcsXG4gICAgICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RDJywgJ1VTRFQnLCAnMTAwJyksXG4gICAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgICByZWNpcGllbnQ6IGFsaWNlLmFkZHJlc3MsXG4gICAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgICBhbGdvcml0aG06ICdhbHBoYScsXG4gICAgICAgICAgICAgICAgZm9yY2VDcm9zc1Byb3RvY29sOiB0cnVlLFxuICAgICAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlOiBBeGlvc1Jlc3BvbnNlPFF1b3RlUmVzcG9uc2U+ID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICAgICAgZGF0YTogeyBxdW90ZSwgcXVvdGVEZWNpbWFscywgcXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzLCBtZXRob2RQYXJhbWV0ZXJzLCByb3V0ZSB9LFxuICAgICAgICAgICAgICAgIHN0YXR1cyxcbiAgICAgICAgICAgICAgfSA9IHJlc3BvbnNlXG5cbiAgICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW4oOTApXG4gICAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbigxMTApXG5cbiAgICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUubGVzc1RoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBleHBlY3QobWV0aG9kUGFyYW1ldGVycykudG8ubm90LmJlLnVuZGVmaW5lZFxuXG4gICAgICAgICAgICAgIGxldCBoYXNWM1Bvb2wgPSBmYWxzZVxuICAgICAgICAgICAgICBsZXQgaGFzVjJQb29sID0gZmFsc2VcbiAgICAgICAgICAgICAgZm9yIChjb25zdCByIG9mIHJvdXRlKSB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBwb29sIG9mIHIpIHtcbiAgICAgICAgICAgICAgICAgIGlmIChwb29sLnR5cGUgPT0gJ3YzLXBvb2wnKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1YzUG9vbCA9IHRydWVcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgIGlmIChwb29sLnR5cGUgPT0gJ3YyLXBvb2wnKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1YyUG9vbCA9IHRydWVcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBleHBlY3QoaGFzVjNQb29sICYmIGhhc1YyUG9vbCkudG8uYmUudHJ1ZVxuXG4gICAgICAgICAgICAgIGNvbnN0IHsgdG9rZW5JbkJlZm9yZSwgdG9rZW5JbkFmdGVyLCB0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciB9ID0gYXdhaXQgZXhlY3V0ZVN3YXAoXG4gICAgICAgICAgICAgICAgcmVzcG9uc2UuZGF0YS5tZXRob2RQYXJhbWV0ZXJzISxcbiAgICAgICAgICAgICAgICBVU0RDX01BSU5ORVQsXG4gICAgICAgICAgICAgICAgVVNEVF9NQUlOTkVUIVxuICAgICAgICAgICAgICApXG5cbiAgICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgZXhwZWN0KHRva2VuSW5CZWZvcmUuc3VidHJhY3QodG9rZW5JbkFmdGVyKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAnKVxuICAgICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChVU0RUX01BSU5ORVQsIHF1b3RlKSlcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBleHBlY3QodG9rZW5PdXRBZnRlci5zdWJ0cmFjdCh0b2tlbk91dEJlZm9yZSkudG9FeGFjdCgpKS50by5lcXVhbCgnMTAwJylcbiAgICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5JbkJlZm9yZSwgdG9rZW5JbkFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KFVTRENfTUFJTk5FVCwgcXVvdGUpKVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICAvLy8gVGVzdHMgZm9yIHJvdXRlcyBsaWtlbHkgdG8gcmVzdWx0IGluIE1peGVkUm91dGVzIGJlaW5nIHJldHVybmVkXG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgIGl0KGBlcmMyMCAtPiBlcmMyMCBmb3JjZU1peGVkUm91dGVzIG5vdCBzcGVjaWZpZWQgZm9yIHYyLHYzIGRvZXMgbm90IHJldHVybiBtaXhlZCByb3V0ZSBldmVuIHdoZW4gaXQgaXMgYmV0dGVyYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdCT05EJyxcbiAgICAgICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnQVBFJyxcbiAgICAgICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdCT05EJywgJ0FQRScsICcxMDAwMCcpLFxuICAgICAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgICAgIGFsZ29yaXRobTogJ2FscGhhJyxcbiAgICAgICAgICAgICAgICAgIHByb3RvY29sczogJ3YyLHYzJyxcbiAgICAgICAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHFzLnN0cmluZ2lmeShxdW90ZVJlcSlcblxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlOiBBeGlvc1Jlc3BvbnNlPFF1b3RlUmVzcG9uc2U+ID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgICAgIGNvbnN0IHtcbiAgICAgICAgICAgICAgICAgIGRhdGE6IHsgcXVvdGVEZWNpbWFscywgcXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzLCBtZXRob2RQYXJhbWV0ZXJzLCByb3V0ZVN0cmluZyB9LFxuICAgICAgICAgICAgICAgICAgc3RhdHVzLFxuICAgICAgICAgICAgICAgIH0gPSByZXNwb25zZVxuXG4gICAgICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuXG4gICAgICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZXhwZWN0KG1ldGhvZFBhcmFtZXRlcnMpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgICAgIGV4cGVjdCghcm91dGVTdHJpbmcuaW5jbHVkZXMoJ1tWMiArIFYzXScpKVxuICAgICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICAgIGl0KGBlcmMyMCAtPiBlcmMyMCBmb3JjZU1peGVkUm91dGVzIHRydWUgZm9yIHYyLHYzYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdCT05EJyxcbiAgICAgICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnQVBFJyxcbiAgICAgICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdCT05EJywgJ0FQRScsICcxMDAwMCcpLFxuICAgICAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgICAgIGFsZ29yaXRobTogJ2FscGhhJyxcbiAgICAgICAgICAgICAgICAgIGZvcmNlTWl4ZWRSb3V0ZXM6IHRydWUsXG4gICAgICAgICAgICAgICAgICBwcm90b2NvbHM6ICd2Mix2MycsXG4gICAgICAgICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IHRydWUsXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FsbEFuZEV4cGVjdEZhaWwocXVvdGVSZXEsIHtcbiAgICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgICAgZGF0YToge1xuICAgICAgICAgICAgICAgICAgICBkZXRhaWw6ICdObyByb3V0ZSBmb3VuZCcsXG4gICAgICAgICAgICAgICAgICAgIGVycm9yQ29kZTogJ05PX1JPVVRFJyxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgfSlcblxuICAgICAgICAgICAgICBpdC5za2lwKGBlcmMyMCAtPiBlcmMyMCBmb3JjZU1peGVkUm91dGVzIHRydWUgZm9yIGFsbCBwcm90b2NvbHMgc3BlY2lmaWVkYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdCT05EJyxcbiAgICAgICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnQVBFJyxcbiAgICAgICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdCT05EJywgJ0FQRScsICcxMDAwMCcpLFxuICAgICAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgICAgIGFsZ29yaXRobTogJ2FscGhhJyxcbiAgICAgICAgICAgICAgICAgIGZvcmNlTWl4ZWRSb3V0ZXM6IHRydWUsXG4gICAgICAgICAgICAgICAgICBwcm90b2NvbHM6ICd2Mix2MyxtaXhlZCcsXG4gICAgICAgICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IHRydWUsXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZTogQXhpb3NSZXNwb25zZTxRdW90ZVJlc3BvbnNlPiA9IGF3YWl0IGF4aW9zLmdldDxRdW90ZVJlc3BvbnNlPihgJHtBUEl9PyR7cXVlcnlQYXJhbXN9YClcbiAgICAgICAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICAgICAgICBkYXRhOiB7IHF1b3RlRGVjaW1hbHMsIHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscywgbWV0aG9kUGFyYW1ldGVycywgcm91dGVTdHJpbmcgfSxcbiAgICAgICAgICAgICAgICAgIHN0YXR1cyxcbiAgICAgICAgICAgICAgICB9ID0gcmVzcG9uc2VcblxuICAgICAgICAgICAgICAgIGV4cGVjdChzdGF0dXMpLnRvLmVxdWFsKDIwMClcblxuICAgICAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUubGVzc1RoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscykpLnRvLmJlLmdyZWF0ZXJUaGFuT3JFcXVhbChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGV4cGVjdChtZXRob2RQYXJhbWV0ZXJzKS50by5ub3QuYmUudW5kZWZpbmVkXG5cbiAgICAgICAgICAgICAgICAvLy8gc2luY2Ugd2Ugb25seSBnZXQgdGhlIHJvdXRlU3RyaW5nIGJhY2ssIHdlIGNhbiBjaGVjayBpZiB0aGVyZSdzIFYzICsgVjJcbiAgICAgICAgICAgICAgICBleHBlY3Qocm91dGVTdHJpbmcuaW5jbHVkZXMoJ1tWMiArIFYzXScpKVxuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBGT1Qgc3dhcCBvbmx5IHdvcmtzIGZvciBleGFjdCBpblxuICAgICAgICAgICAgaWYgKHR5cGUgPT09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICBjb25zdCB0b2tlbkluQW5kVG9rZW5PdXQgPSBbXG4gICAgICAgICAgICAgICAgW0JVTExFVCwgV0VUSDlbQ2hhaW5JZC5NQUlOTkVUXSFdLFxuICAgICAgICAgICAgICAgIFtXRVRIOVtDaGFpbklkLk1BSU5ORVRdISwgQlVMTEVUXSxcbiAgICAgICAgICAgICAgXVxuXG4gICAgICAgICAgICAgIHRva2VuSW5BbmRUb2tlbk91dC5mb3JFYWNoKChbdG9rZW5JbiwgdG9rZW5PdXRdKSA9PiB7XG4gICAgICAgICAgICAgICAgLy8gSWYgdGhpcyB0ZXN0IGZhaWxzIHNwb3JhZGljYWxseSwgZGV2IG5lZWRzIHRvIGludmVzdGlnYXRlIGZ1cnRoZXJcbiAgICAgICAgICAgICAgICAvLyBUaGVyZSBjb3VsZCBiZSBnZW51aW5lIHJlZ3Jlc3Npb25zIGluIHRoZSBmb3JtIG9mIHJhY2UgY29uZGl0aW9uLCBkdWUgdG8gY29tcGxleCBsYXllcnMgb2YgY2FjaGluZ1xuICAgICAgICAgICAgICAgIC8vIFNlZSBodHRwczovL2dpdGh1Yi5jb20vVW5pc3dhcC9zbWFydC1vcmRlci1yb3V0ZXIvcHVsbC80MTUjaXNzdWUtMTkxNDYwNDg2NCBhcyBhbiBleGFtcGxlIHJhY2UgY29uZGl0aW9uXG4gICAgICAgICAgICAgICAgaXQoYGZlZS1vbi10cmFuc2ZlciAke3Rva2VuSW4uc3ltYm9sfSAtPiAke3Rva2VuT3V0LnN5bWJvbH1gLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICBjb25zdCBlbmFibGVGZWVPblRyYW5zZmVyRmVlRmV0Y2hpbmcgPSBbdHJ1ZSwgZmFsc2UsIHVuZGVmaW5lZF1cbiAgICAgICAgICAgICAgICAgIC8vIHdlIHdhbnQgdG8gc3dhcCB0aGUgdG9rZW5Jbi90b2tlbk91dCBvcmRlciBzbyB0aGF0IHdlIGNhbiB0ZXN0IGJvdGggc2VsbEZlZUJwcyBhbmQgYnV5RmVlQnBzIGZvciBleGFjdEluIHZzIGV4YWN0T3V0XG4gICAgICAgICAgICAgICAgICBjb25zdCBvcmlnaW5hbEFtb3VudCA9IHRva2VuSW4uZXF1YWxzKFdFVEg5W0NoYWluSWQuTUFJTk5FVF0hKSA/ICcxMCcgOiAnMjkyNCdcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGFtb3VudCA9IGF3YWl0IGdldEFtb3VudEZyb21Ub2tlbih0eXBlLCB0b2tlbkluLCB0b2tlbk91dCwgb3JpZ2luYWxBbW91bnQpXG5cbiAgICAgICAgICAgICAgICAgIC8vIFBhcmFsbGVsaXplIHRoZSBGT1QgcXVvdGUgcmVxdWVzdHMsIGJlY2F1c2Ugd2Ugbm90aWNlIHRoZXJlIG1pZ2h0IGJlIHRyaWNreSByYWNlIGNvbmRpdGlvbiB0aGF0IGNvdWxkIGNhdXNlIHF1b3RlIHRvIG5vdCBpbmNsdWRlIEZPVCB0YXhcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlcyA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgICAgICAgICAgICAgICBlbmFibGVGZWVPblRyYW5zZmVyRmVlRmV0Y2hpbmcubWFwKGFzeW5jIChlbmFibGVGZWVPblRyYW5zZmVyRmVlRmV0Y2hpbmcpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICBpZiAoZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBpZiBpdCdzIEZPVCBmbGFnIGVuYWJsZWQgcmVxdWVzdCwgd2UgZGVsYXkgaXQgc28gdGhhdCBpdCdzIG1vcmUgbGlrZWx5IHRvIHJlcHJvIHRoZSByYWNlIGNvbmRpdGlvbiBpblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL1VuaXN3YXAvc21hcnQtb3JkZXItcm91dGVyL3B1bGwvNDE1I2lzc3VlLTE5MTQ2MDQ4NjRcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChmKSA9PiBzZXRUaW1lb3V0KGYsIDEwMDApKVxuICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzaW11bGF0ZUZyb21BZGRyZXNzID0gdG9rZW5Jbi5lcXVhbHMoV0VUSDlbQ2hhaW5JZC5NQUlOTkVUXSEpXG4gICAgICAgICAgICAgICAgICAgICAgICA/ICcweDJmRWIxNTEyMTgzNTQ1ZjQ4ZjZiOUM1YjRFYmZDYUY0OUNmQ2E2RjMnXG4gICAgICAgICAgICAgICAgICAgICAgICA6ICcweDE3MWQzMTFlQWNkMjIwNmQyMUNiNDYyZDY2MUMzM0YwZWRkYWRDMDMnXG4gICAgICAgICAgICAgICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0b2tlbkluQWRkcmVzczogdG9rZW5Jbi5hZGRyZXNzLFxuICAgICAgICAgICAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IHRva2VuSW4uY2hhaW5JZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogdG9rZW5PdXQuYWRkcmVzcyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogdG9rZW5PdXQuY2hhaW5JZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFtb3VudDogYW1vdW50LFxuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogdHlwZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb3RvY29sczogJ3YyLHYzLG1peGVkJyxcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRPRE86IFJPVVRFLTg2IHJlbW92ZSBlbmFibGVGZWVPblRyYW5zZmVyRmVlRmV0Y2hpbmcgb25jZSB3ZSBhcmUgcmVhZHkgdG8gZW5hYmxlIHRoaXMgYnkgZGVmYXVsdFxuICAgICAgICAgICAgICAgICAgICAgICAgZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nOiBlbmFibGVGZWVPblRyYW5zZmVyRmVlRmV0Y2hpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICByZWNpcGllbnQ6IGFsaWNlLmFkZHJlc3MsXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyB3ZSBoYXZlIHRvIHVzZSBsYXJnZSBzbGlwcGFnZSBmb3IgRk9UIHN3YXAsIGJlY2F1c2Ugcm91dGluZy1hcGkgYWx3YXlzIGZvcmtzIGF0IHRoZSBsYXRlc3QgYmxvY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBhbmQgdGhlIEZPVCBzd2FwIGNhbiBoYXZlIGxhcmdlIHNsaXBwYWdlLCBkZXNwaXRlIFNPUiBhbHJlYWR5IHN1YnRyYWN0ZWQgRk9UIHRheFxuICAgICAgICAgICAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IExBUkdFX1NMSVBQQUdFLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gaWYgZmVlLW9uLXRyYW5zZmVyIGZsYWcgaXMgbm90IGVuYWJsZWQsIG1vc3QgbGlrZWx5IHRoZSBzaW11bGF0aW9uIHdpbGwgZmFpbCBkdWUgdG8gcXVvdGUgbm90IHN1YnRyYWN0aW5nIHRoZSB0YXhcbiAgICAgICAgICAgICAgICAgICAgICAgIHNpbXVsYXRlRnJvbUFkZHJlc3M6IGVuYWJsZUZlZU9uVHJhbnNmZXJGZWVGZXRjaGluZyA/IHNpbXVsYXRlRnJvbUFkZHJlc3MgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZTogQXhpb3NSZXNwb25zZTxRdW90ZVJlc3BvbnNlPiA9IGF3YWl0IGF4aW9zLmdldDxRdW90ZVJlc3BvbnNlPihcbiAgICAgICAgICAgICAgICAgICAgICAgIGAke0FQSX0/JHtxdWVyeVBhcmFtc31gXG4gICAgICAgICAgICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nLCAuLi5yZXNwb25zZSB9XG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICApXG5cbiAgICAgICAgICAgICAgICAgIGNvbnN0IHF1b3RlV2l0aEZsYWdPbiA9IHJlc3BvbnNlcy5maW5kKChyKSA9PiByLmVuYWJsZUZlZU9uVHJhbnNmZXJGZWVGZXRjaGluZyA9PT0gdHJ1ZSlcbiAgICAgICAgICAgICAgICAgIGV4cGVjdChxdW90ZVdpdGhGbGFnT24pLm5vdC50by5iZS51bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgIHJlc3BvbnNlc1xuICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKChyKSA9PiByLmVuYWJsZUZlZU9uVHJhbnNmZXJGZWVGZXRjaGluZyAhPT0gdHJ1ZSlcbiAgICAgICAgICAgICAgICAgICAgLmZvckVhY2goKHIpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZSA9PT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBxdW90ZSA9IEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQodG9rZW5PdXQsIHIuZGF0YS5xdW90ZSlcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHF1b3RlV2l0aEZsYWdvbiA9IEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQodG9rZW5PdXQsIHF1b3RlV2l0aEZsYWdPbiEuZGF0YS5xdW90ZSlcblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gcXVvdGUgd2l0aG91dCBmb3QgZmxhZyBtdXN0IGJlIGdyZWF0ZXIgdGhhbiB0aGUgcXVvdGUgd2l0aCBmb3QgZmxhZ1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gdGhpcyBpcyB0byBjYXRjaCBodHRwczovL2dpdGh1Yi5jb20vVW5pc3dhcC9zbWFydC1vcmRlci1yb3V0ZXIvcHVsbC80MjFcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdChxdW90ZS5ncmVhdGVyVGhhbihxdW90ZVdpdGhGbGFnb24pKS50by5iZS50cnVlXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGJlbG93IGlzIGFkZGl0aW9uYWwgYXNzZXJ0aW9uIHRvIGVuc3VyZSB0aGUgcXVvdGUgd2l0aG91dCBmb3QgdGF4IHZzIHF1b3RlIHdpdGggdGF4IHNob3VsZCBiZSB2ZXJ5IHJvdWdobHkgZXF1YWwgdG8gdGhlIGZvdCBzZWxsL2J1eSB0YXggcmF0ZVxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdG9rZW5zRGlmZiA9IHF1b3RlLnN1YnRyYWN0KHF1b3RlV2l0aEZsYWdvbilcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHBlcmNlbnREaWZmID0gdG9rZW5zRGlmZi5hc0ZyYWN0aW9uLmRpdmlkZShxdW90ZS5hc0ZyYWN0aW9uKVxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRva2VuSW4/LmVxdWFscyhCVUxMRVQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdChwZXJjZW50RGlmZi50b0ZpeGVkKDMsIHVuZGVmaW5lZCwgUm91bmRpbmcuUk9VTkRfSEFMRl9VUCkpLmVxdWFsKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5ldyBGcmFjdGlvbihCaWdOdW1iZXIuZnJvbShCVUxMRVRfV0hUX1RBWC5zZWxsRmVlQnBzID8/IDApLnRvU3RyaW5nKCksIDEwXzAwMCkudG9GaXhlZCgzKVxuICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHRva2VuT3V0Py5lcXVhbHMoQlVMTEVUKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICBleHBlY3QocGVyY2VudERpZmYudG9GaXhlZCgzLCB1bmRlZmluZWQsIFJvdW5kaW5nLlJPVU5EX0hBTEZfVVApKS5lcXVhbChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBuZXcgRnJhY3Rpb24oQmlnTnVtYmVyLmZyb20oQlVMTEVUX1dIVF9UQVguYnV5RmVlQnBzID8/IDApLnRvU3RyaW5nKCksIDEwXzAwMCkudG9GaXhlZCgzKVxuICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHJlc3BvbnNlIG9mIHJlc3BvbnNlcykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICAgICAgICAgICAgZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nLFxuICAgICAgICAgICAgICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHF1b3RlLFxuICAgICAgICAgICAgICAgICAgICAgICAgcXVvdGVEZWNpbWFscyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscyxcbiAgICAgICAgICAgICAgICAgICAgICAgIG1ldGhvZFBhcmFtZXRlcnMsXG4gICAgICAgICAgICAgICAgICAgICAgICByb3V0ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHNpbXVsYXRpb25TdGF0dXMsXG4gICAgICAgICAgICAgICAgICAgICAgICBzaW11bGF0aW9uRXJyb3IsXG4gICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICBzdGF0dXMsXG4gICAgICAgICAgICAgICAgICAgIH0gPSByZXNwb25zZVxuXG4gICAgICAgICAgICAgICAgICAgIGV4cGVjdChzdGF0dXMpLnRvLmVxdWFsKDIwMClcblxuICAgICAgICAgICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBoYXNWM1Bvb2wgPSBmYWxzZVxuICAgICAgICAgICAgICAgICAgICBsZXQgaGFzVjJQb29sID0gZmFsc2VcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCByIG9mIHJvdXRlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBwb29sIG9mIHIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwb29sLnR5cGUgPT0gJ3YzLXBvb2wnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGhhc1YzUG9vbCA9IHRydWVcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwb29sLnR5cGUgPT0gJ3YyLXBvb2wnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGhhc1YyUG9vbCA9IHRydWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGVuYWJsZUZlZU9uVHJhbnNmZXJGZWVGZXRjaGluZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwb29sLnRva2VuSW4uYWRkcmVzcyA9PT0gQlVMTEVULmFkZHJlc3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdChwb29sLnRva2VuSW4uc2VsbEZlZUJwcykudG8uYmUubm90LnVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhwZWN0KHBvb2wudG9rZW5Jbi5zZWxsRmVlQnBzKS50by5iZS5lcXVhbHMoQlVMTEVUX1dIVF9UQVguc2VsbEZlZUJwcz8udG9TdHJpbmcoKSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdChwb29sLnRva2VuSW4uYnV5RmVlQnBzKS50by5iZS5ub3QudW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHBlY3QocG9vbC50b2tlbkluLmJ1eUZlZUJwcykudG8uYmUuZXF1YWxzKEJVTExFVF9XSFRfVEFYLmJ1eUZlZUJwcz8udG9TdHJpbmcoKSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHBvb2wudG9rZW5PdXQuYWRkcmVzcyA9PT0gQlVMTEVULmFkZHJlc3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdChwb29sLnRva2VuT3V0LnNlbGxGZWVCcHMpLnRvLmJlLm5vdC51bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdChwb29sLnRva2VuT3V0LnNlbGxGZWVCcHMpLnRvLmJlLmVxdWFscyhCVUxMRVRfV0hUX1RBWC5zZWxsRmVlQnBzPy50b1N0cmluZygpKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhwZWN0KHBvb2wudG9rZW5PdXQuYnV5RmVlQnBzKS50by5iZS5ub3QudW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHBlY3QocG9vbC50b2tlbk91dC5idXlGZWVCcHMpLnRvLmJlLmVxdWFscyhCVUxMRVRfV0hUX1RBWC5idXlGZWVCcHM/LnRvU3RyaW5nKCkpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwb29sLnJlc2VydmUwLnRva2VuLmFkZHJlc3MgPT09IEJVTExFVC5hZGRyZXNzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHBlY3QocG9vbC5yZXNlcnZlMC50b2tlbi5zZWxsRmVlQnBzKS50by5iZS5ub3QudW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHBlY3QocG9vbC5yZXNlcnZlMC50b2tlbi5zZWxsRmVlQnBzKS50by5iZS5lcXVhbHMoQlVMTEVUX1dIVF9UQVguc2VsbEZlZUJwcz8udG9TdHJpbmcoKSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdChwb29sLnJlc2VydmUwLnRva2VuLmJ1eUZlZUJwcykudG8uYmUubm90LnVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhwZWN0KHBvb2wucmVzZXJ2ZTAudG9rZW4uYnV5RmVlQnBzKS50by5iZS5lcXVhbHMoQlVMTEVUX1dIVF9UQVguYnV5RmVlQnBzPy50b1N0cmluZygpKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAocG9vbC5yZXNlcnZlMS50b2tlbi5hZGRyZXNzID09PSBCVUxMRVQuYWRkcmVzcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhwZWN0KHBvb2wucmVzZXJ2ZTEudG9rZW4uc2VsbEZlZUJwcykudG8uYmUubm90LnVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhwZWN0KHBvb2wucmVzZXJ2ZTEudG9rZW4uc2VsbEZlZUJwcykudG8uYmUuZXF1YWxzKEJVTExFVF9XSFRfVEFYLnNlbGxGZWVCcHM/LnRvU3RyaW5nKCkpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHBlY3QocG9vbC5yZXNlcnZlMS50b2tlbi5idXlGZWVCcHMpLnRvLmJlLm5vdC51bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdChwb29sLnJlc2VydmUxLnRva2VuLmJ1eUZlZUJwcykudG8uYmUuZXF1YWxzKEJVTExFVF9XSFRfVEFYLmJ1eUZlZUJwcz8udG9TdHJpbmcoKSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhwZWN0KHBvb2wudG9rZW5PdXQuc2VsbEZlZUJwcykudG8uYmUudW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhwZWN0KHBvb2wudG9rZW5PdXQuYnV5RmVlQnBzKS50by5iZS51bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHBlY3QocG9vbC5yZXNlcnZlMC50b2tlbi5zZWxsRmVlQnBzKS50by5iZS51bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHBlY3QocG9vbC5yZXNlcnZlMC50b2tlbi5idXlGZWVCcHMpLnRvLmJlLnVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdChwb29sLnJlc2VydmUxLnRva2VuLnNlbGxGZWVCcHMpLnRvLmJlLnVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdChwb29sLnJlc2VydmUxLnRva2VuLmJ1eUZlZUJwcykudG8uYmUudW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBleHBlY3QoIWhhc1YzUG9vbCAmJiBoYXNWMlBvb2wpLnRvLmJlLnRydWVcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgZXhwZWN0KHNpbXVsYXRpb25TdGF0dXMpLnRvLmVxdWFsKCdTVUNDRVNTJylcbiAgICAgICAgICAgICAgICAgICAgICBleHBlY3Qoc2ltdWxhdGlvbkVycm9yKS50by5lcXVhbChmYWxzZSlcbiAgICAgICAgICAgICAgICAgICAgICBleHBlY3QobWV0aG9kUGFyYW1ldGVycykudG8ubm90LmJlLnVuZGVmaW5lZFxuXG4gICAgICAgICAgICAgICAgICAgICAgLy8gV2UgZG9uJ3QgaGF2ZSBhIGJ1bGxldCBwcm9vZiB3YXkgdG8gYXNzZXJ0IHRoZSBmb3QtaW52b2x2ZWQgcXVvdGUgaXMgcG9zdCB0YXhcbiAgICAgICAgICAgICAgICAgICAgICAvLyBzbyB0aGUgYmVzdCB3YXkgaXMgdG8gZXhlY3V0ZSB0aGUgc3dhcCBvbiBoYXJkaGF0IG1haW5uZXQgZm9yayxcbiAgICAgICAgICAgICAgICAgICAgICAvLyBhbmQgbWFrZSBzdXJlIHRoZSBleGVjdXRlZCBxdW90ZSBkb2Vzbid0IGRpZmZlciBmcm9tIGNhbGxzdGF0aWMgc2ltdWxhdGVkIHF1b3RlIGJ5IG92ZXIgc2xpcHBhZ2UgdG9sZXJhbmNlXG4gICAgICAgICAgICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlLmRhdGEubWV0aG9kUGFyYW1ldGVycyEsXG4gICAgICAgICAgICAgICAgICAgICAgICB0b2tlbkluLFxuICAgICAgICAgICAgICAgICAgICAgICAgdG9rZW5PdXRcbiAgICAgICAgICAgICAgICAgICAgICApXG5cbiAgICAgICAgICAgICAgICAgICAgICBleHBlY3QodG9rZW5JbkJlZm9yZS5zdWJ0cmFjdCh0b2tlbkluQWZ0ZXIpLnRvRXhhY3QoKSkudG8uZXF1YWwob3JpZ2luYWxBbW91bnQpXG4gICAgICAgICAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KHRva2VuT3V0LCBxdW90ZSkpXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSlcblxuICAgICAgICBpZiAoYWxnb3JpdGhtID09ICdhbHBoYScpIHtcbiAgICAgICAgICBkZXNjcmliZShgKyBTaW11bGF0ZSBTd2FwICsgRXhlY3V0ZSBTd2FwYCwgKCkgPT4ge1xuICAgICAgICAgICAgaXQoYGVyYzIwIC0+IGVyYzIwYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ1VTREMnLFxuICAgICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ1VTRFQnLFxuICAgICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgICBhbW91bnQ6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnVVNEQycsICdVU0RUJywgJzEwMCcpLFxuICAgICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgICAgIHNpbXVsYXRlRnJvbUFkZHJlc3M6ICcweGY1ODRmODcyOGI4NzRhNmE1YzdhOGQ0ZDM4N2M5YWFlOTE3MmQ2MjEnLFxuICAgICAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlOiBBeGlvc1Jlc3BvbnNlPFF1b3RlUmVzcG9uc2U+ID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICAgICAgZGF0YTogeyBxdW90ZSwgcXVvdGVEZWNpbWFscywgcXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzLCBtZXRob2RQYXJhbWV0ZXJzLCBzaW11bGF0aW9uRXJyb3IgfSxcbiAgICAgICAgICAgICAgICBzdGF0dXMsXG4gICAgICAgICAgICAgIH0gPSByZXNwb25zZVxuXG4gICAgICAgICAgICAgIGV4cGVjdChzdGF0dXMpLnRvLmVxdWFsKDIwMClcbiAgICAgICAgICAgICAgZXhwZWN0KHNpbXVsYXRpb25FcnJvcikudG8uZXF1YWwoZmFsc2UpXG4gICAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbig5MClcbiAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpLnRvLmJlLmxlc3NUaGFuKDExMClcblxuICAgICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGV4cGVjdChtZXRob2RQYXJhbWV0ZXJzKS50by5ub3QuYmUudW5kZWZpbmVkXG5cbiAgICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgICBtZXRob2RQYXJhbWV0ZXJzISxcbiAgICAgICAgICAgICAgICBVU0RDX01BSU5ORVQsXG4gICAgICAgICAgICAgICAgVVNEVF9NQUlOTkVUXG4gICAgICAgICAgICAgIClcblxuICAgICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgICBleHBlY3QodG9rZW5JbkJlZm9yZS5zdWJ0cmFjdCh0b2tlbkluQWZ0ZXIpLnRvRXhhY3QoKSkudG8uZXF1YWwoJzEwMCcpXG4gICAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KFVTRFRfTUFJTk5FVCwgcXVvdGUpKVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGV4cGVjdCh0b2tlbk91dEFmdGVyLnN1YnRyYWN0KHRva2VuT3V0QmVmb3JlKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAnKVxuICAgICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoVVNEQ19NQUlOTkVULCBxdW90ZSkpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgIGl0KGBlcmMyMCAtPiBlcmMyMCBzd2Fwcm91dGVyMDJgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiAnVVNEQycsXG4gICAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEVCcsXG4gICAgICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RDJywgJ1VTRFQnLCAnMTAwJyksXG4gICAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgICByZWNpcGllbnQ6IGFsaWNlLmFkZHJlc3MsXG4gICAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgICBhbGdvcml0aG0sXG4gICAgICAgICAgICAgICAgc2ltdWxhdGVGcm9tQWRkcmVzczogJzB4ZjU4NGY4NzI4Yjg3NGE2YTVjN2E4ZDRkMzg3YzlhYWU5MTcyZDYyMScsXG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHFzLnN0cmluZ2lmeShxdW90ZVJlcSlcblxuICAgICAgICAgICAgICBjb25zdCByZXNwb25zZTogQXhpb3NSZXNwb25zZTxRdW90ZVJlc3BvbnNlPiA9IGF3YWl0IGF4aW9zLmdldDxRdW90ZVJlc3BvbnNlPihgJHtBUEl9PyR7cXVlcnlQYXJhbXN9YClcbiAgICAgICAgICAgICAgY29uc3Qge1xuICAgICAgICAgICAgICAgIGRhdGE6IHsgcXVvdGUsIHF1b3RlRGVjaW1hbHMsIHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscywgbWV0aG9kUGFyYW1ldGVycywgc2ltdWxhdGlvbkVycm9yIH0sXG4gICAgICAgICAgICAgICAgc3RhdHVzLFxuICAgICAgICAgICAgICB9ID0gcmVzcG9uc2VcblxuICAgICAgICAgICAgICBleHBlY3Qoc3RhdHVzKS50by5lcXVhbCgyMDApXG4gICAgICAgICAgICAgIGV4cGVjdChzaW11bGF0aW9uRXJyb3IpLnRvLmVxdWFsKGZhbHNlKVxuICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW4oOTApXG4gICAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbigxMTApXG5cbiAgICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUubGVzc1RoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBleHBlY3QobWV0aG9kUGFyYW1ldGVycykudG8ubm90LmJlLnVuZGVmaW5lZFxuICAgICAgICAgICAgICBleHBlY3QobWV0aG9kUGFyYW1ldGVycyEudG8pLnRvLmVxdWFsKFNXQVBfUk9VVEVSXzAyX0FERFJFU1NFUyhDaGFpbklkLk1BSU5ORVQpKVxuXG4gICAgICAgICAgICAgIGNvbnN0IHsgdG9rZW5JbkJlZm9yZSwgdG9rZW5JbkFmdGVyLCB0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciB9ID0gYXdhaXQgZXhlY3V0ZVN3YXAoXG4gICAgICAgICAgICAgICAgbWV0aG9kUGFyYW1ldGVycyEsXG4gICAgICAgICAgICAgICAgVVNEQ19NQUlOTkVULFxuICAgICAgICAgICAgICAgIFVTRFRfTUFJTk5FVFxuICAgICAgICAgICAgICApXG5cbiAgICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgZXhwZWN0KHRva2VuSW5CZWZvcmUuc3VidHJhY3QodG9rZW5JbkFmdGVyKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAnKVxuICAgICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChVU0RUX01BSU5ORVQsIHF1b3RlKSlcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBleHBlY3QodG9rZW5PdXRBZnRlci5zdWJ0cmFjdCh0b2tlbk91dEJlZm9yZSkudG9FeGFjdCgpKS50by5lcXVhbCgnMTAwJylcbiAgICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5JbkJlZm9yZSwgdG9rZW5JbkFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KFVTRENfTUFJTk5FVCwgcXVvdGUpKVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICBpZiAoaXNUZXN0ZXJQS0Vudmlyb25tZW50U2V0KCkpIHtcbiAgICAgICAgICAgICAgaXQoYGVyYzIwIC0+IGVyYzIwIHdpdGggcGVybWl0IHdpdGggdGVzdGVyIHBrYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgIC8vIFRoaXMgdGVzdCByZXF1aXJlcyBhIHByaXZhdGUga2V5IHdpdGggYXQgbGVhc3QgMTAgVVNEQ1xuICAgICAgICAgICAgICAgIC8vIGF0IEZPUktfQkxPQ0sgdGltZS5cbiAgICAgICAgICAgICAgICBjb25zdCBhbW91bnQgPSBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ1VTREMnLCAnVVNEVCcsICcxMCcpXG5cbiAgICAgICAgICAgICAgICBjb25zdCBub25jZSA9ICcwJ1xuXG4gICAgICAgICAgICAgICAgY29uc3QgcGVybWl0OiBQZXJtaXRTaW5nbGUgPSB7XG4gICAgICAgICAgICAgICAgICBkZXRhaWxzOiB7XG4gICAgICAgICAgICAgICAgICAgIHRva2VuOiBVU0RDX01BSU5ORVQuYWRkcmVzcyxcbiAgICAgICAgICAgICAgICAgICAgYW1vdW50OiBhbW91bnQsXG4gICAgICAgICAgICAgICAgICAgIGV4cGlyYXRpb246IE1hdGguZmxvb3IobmV3IERhdGUoKS5nZXRUaW1lKCkgLyAxMDAwICsgMTAwMDAwMDApLnRvU3RyaW5nKCksXG4gICAgICAgICAgICAgICAgICAgIG5vbmNlLFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgIHNwZW5kZXI6IFVOSVZFUlNBTF9ST1VURVJfQUREUkVTUyxcbiAgICAgICAgICAgICAgICAgIHNpZ0RlYWRsaW5lOiBNYXRoLmZsb29yKG5ldyBEYXRlKCkuZ2V0VGltZSgpIC8gMTAwMCArIDEwMDAwMDAwKS50b1N0cmluZygpLFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IHdhbGxldCA9IG5ldyBXYWxsZXQocHJvY2Vzcy5lbnYuVEVTVEVSX1BLISlcblxuICAgICAgICAgICAgICAgIGNvbnN0IHsgZG9tYWluLCB0eXBlcywgdmFsdWVzIH0gPSBBbGxvd2FuY2VUcmFuc2Zlci5nZXRQZXJtaXREYXRhKHBlcm1pdCwgUEVSTUlUMl9BRERSRVNTLCAxKVxuXG4gICAgICAgICAgICAgICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgd2FsbGV0Ll9zaWduVHlwZWREYXRhKGRvbWFpbiwgdHlwZXMsIHZhbHVlcylcblxuICAgICAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RDJyxcbiAgICAgICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEVCcsXG4gICAgICAgICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICAgICAgICBhbW91bnQsXG4gICAgICAgICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgICAgICAgcmVjaXBpZW50OiB3YWxsZXQuYWRkcmVzcyxcbiAgICAgICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgICAgICAgIHNpbXVsYXRlRnJvbUFkZHJlc3M6IHdhbGxldC5hZGRyZXNzLFxuICAgICAgICAgICAgICAgICAgcGVybWl0U2lnbmF0dXJlOiBzaWduYXR1cmUsXG4gICAgICAgICAgICAgICAgICBwZXJtaXRBbW91bnQ6IHBlcm1pdC5kZXRhaWxzLmFtb3VudC50b1N0cmluZygpLFxuICAgICAgICAgICAgICAgICAgcGVybWl0RXhwaXJhdGlvbjogcGVybWl0LmRldGFpbHMuZXhwaXJhdGlvbi50b1N0cmluZygpLFxuICAgICAgICAgICAgICAgICAgcGVybWl0U2lnRGVhZGxpbmU6IHBlcm1pdC5zaWdEZWFkbGluZS50b1N0cmluZygpLFxuICAgICAgICAgICAgICAgICAgcGVybWl0Tm9uY2U6IHBlcm1pdC5kZXRhaWxzLm5vbmNlLnRvU3RyaW5nKCksXG4gICAgICAgICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IHRydWUsXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZTogQXhpb3NSZXNwb25zZTxRdW90ZVJlc3BvbnNlPiA9IGF3YWl0IGF4aW9zLmdldDxRdW90ZVJlc3BvbnNlPihgJHtBUEl9PyR7cXVlcnlQYXJhbXN9YClcbiAgICAgICAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICAgICAgICBkYXRhOiB7IHF1b3RlRGVjaW1hbHMsIHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscywgbWV0aG9kUGFyYW1ldGVycywgc2ltdWxhdGlvbkVycm9yIH0sXG4gICAgICAgICAgICAgICAgICBzdGF0dXMsXG4gICAgICAgICAgICAgICAgfSA9IHJlc3BvbnNlXG4gICAgICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuXG4gICAgICAgICAgICAgICAgZXhwZWN0KHNpbXVsYXRpb25FcnJvcikudG8uZXF1YWwoZmFsc2UpXG5cbiAgICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW4oOSlcbiAgICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSkudG8uYmUubGVzc1RoYW4oMTEpXG5cbiAgICAgICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscykpLnRvLmJlLmxlc3NUaGFuT3JFcXVhbChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBleHBlY3QobWV0aG9kUGFyYW1ldGVycykudG8ubm90LmJlLnVuZGVmaW5lZFxuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpdChgZXJjMjAgLT4gZXRoYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ1VTREMnLFxuICAgICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ0VUSCcsXG4gICAgICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RDJywgJ0VUSCcsIHR5cGUgPT0gJ2V4YWN0SW4nID8gJzEwMDAwMDAnIDogJzEwJyksXG4gICAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgICByZWNpcGllbnQ6IGFsaWNlLmFkZHJlc3MsXG4gICAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgICBhbGdvcml0aG0sXG4gICAgICAgICAgICAgICAgc2ltdWxhdGVGcm9tQWRkcmVzczogJzB4ZjU4NGY4NzI4Yjg3NGE2YTVjN2E4ZDRkMzg3YzlhYWU5MTcyZDYyMScsXG4gICAgICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgICAgICAgICAgIGNvbnN0IHtcbiAgICAgICAgICAgICAgICBkYXRhOiB7IHF1b3RlLCBtZXRob2RQYXJhbWV0ZXJzLCBzaW11bGF0aW9uRXJyb3IgfSxcbiAgICAgICAgICAgICAgICBzdGF0dXMsXG4gICAgICAgICAgICAgIH0gPSByZXNwb25zZVxuXG4gICAgICAgICAgICAgIGV4cGVjdChzdGF0dXMpLnRvLmVxdWFsKDIwMClcbiAgICAgICAgICAgICAgZXhwZWN0KHNpbXVsYXRpb25FcnJvcikudG8uZXF1YWwoZmFsc2UpXG4gICAgICAgICAgICAgIGV4cGVjdChtZXRob2RQYXJhbWV0ZXJzKS50by5ub3QuYmUudW5kZWZpbmVkXG5cbiAgICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgICBtZXRob2RQYXJhbWV0ZXJzISxcbiAgICAgICAgICAgICAgICBVU0RDX01BSU5ORVQsXG4gICAgICAgICAgICAgICAgRXRoZXIub25DaGFpbigxKVxuICAgICAgICAgICAgICApXG5cbiAgICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgZXhwZWN0KHRva2VuSW5CZWZvcmUuc3VidHJhY3QodG9rZW5JbkFmdGVyKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAwMDAwJylcbiAgICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoRXRoZXIub25DaGFpbigxKSwgcXVvdGUpKVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIEhhcmQgdG8gdGVzdCBFVEggYmFsYW5jZSBkdWUgdG8gZ2FzIGNvc3RzIGZvciBhcHByb3ZhbCBhbmQgc3dhcC4gSnVzdCBjaGVjayB0b2tlbkluIGNoYW5nZXNcbiAgICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5JbkJlZm9yZSwgdG9rZW5JbkFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KFVTRENfTUFJTk5FVCwgcXVvdGUpKVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICBpdChgZXJjMjAgLT4gZXRoIGxhcmdlIHRyYWRlYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAvLyBUcmFkZSBvZiB0aGlzIHNpemUgYWxtb3N0IGFsd2F5cyByZXN1bHRzIGluIHNwbGl0cy5cbiAgICAgICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RDJyxcbiAgICAgICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6ICdFVEgnLFxuICAgICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgICBhbW91bnQ6XG4gICAgICAgICAgICAgICAgICB0eXBlID09ICdleGFjdEluJ1xuICAgICAgICAgICAgICAgICAgICA/IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnVVNEQycsICdFVEgnLCAnMTAwMDAwMCcpXG4gICAgICAgICAgICAgICAgICAgIDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RDJywgJ0VUSCcsICcxMDAnKSxcbiAgICAgICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgICAgICBzbGlwcGFnZVRvbGVyYW5jZTogU0xJUFBBR0UsXG4gICAgICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgICAgICBzaW11bGF0ZUZyb21BZGRyZXNzOiAnMHhmNTg0Zjg3MjhiODc0YTZhNWM3YThkNGQzODdjOWFhZTkxNzJkNjIxJyxcbiAgICAgICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IHRydWUsXG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHFzLnN0cmluZ2lmeShxdW90ZVJlcSlcblxuICAgICAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGF4aW9zLmdldDxRdW90ZVJlc3BvbnNlPihgJHtBUEl9PyR7cXVlcnlQYXJhbXN9YClcbiAgICAgICAgICAgICAgY29uc3QgeyBkYXRhLCBzdGF0dXMgfSA9IHJlc3BvbnNlXG5cbiAgICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgICAgICBleHBlY3QoZGF0YS5zaW11bGF0aW9uRXJyb3IpLnRvLmVxdWFsKGZhbHNlKVxuICAgICAgICAgICAgICBleHBlY3QoZGF0YS5tZXRob2RQYXJhbWV0ZXJzKS50by5ub3QuYmUudW5kZWZpbmVkXG5cbiAgICAgICAgICAgICAgZXhwZWN0KGRhdGEucm91dGUpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgICBjb25zdCBhbW91bnRJbkVkZ2VzVG90YWwgPSBfKGRhdGEucm91dGUpXG4gICAgICAgICAgICAgICAgLmZsYXRNYXAoKHJvdXRlKSA9PiByb3V0ZVswXSEpXG4gICAgICAgICAgICAgICAgLmZpbHRlcigocG9vbCkgPT4gISFwb29sLmFtb3VudEluKVxuICAgICAgICAgICAgICAgIC5tYXAoKHBvb2wpID0+IEJpZ051bWJlci5mcm9tKHBvb2wuYW1vdW50SW4pKVxuICAgICAgICAgICAgICAgIC5yZWR1Y2UoKGN1ciwgdG90YWwpID0+IHRvdGFsLmFkZChjdXIpLCBCaWdOdW1iZXIuZnJvbSgwKSlcbiAgICAgICAgICAgICAgY29uc3QgYW1vdW50SW4gPSBCaWdOdW1iZXIuZnJvbShkYXRhLnF1b3RlKVxuICAgICAgICAgICAgICBleHBlY3QoYW1vdW50SW4uZXEoYW1vdW50SW5FZGdlc1RvdGFsKSlcblxuICAgICAgICAgICAgICBjb25zdCBhbW91bnRPdXRFZGdlc1RvdGFsID0gXyhkYXRhLnJvdXRlKVxuICAgICAgICAgICAgICAgIC5mbGF0TWFwKChyb3V0ZSkgPT4gcm91dGVbMF0hKVxuICAgICAgICAgICAgICAgIC5maWx0ZXIoKHBvb2wpID0+ICEhcG9vbC5hbW91bnRPdXQpXG4gICAgICAgICAgICAgICAgLm1hcCgocG9vbCkgPT4gQmlnTnVtYmVyLmZyb20ocG9vbC5hbW91bnRPdXQpKVxuICAgICAgICAgICAgICAgIC5yZWR1Y2UoKGN1ciwgdG90YWwpID0+IHRvdGFsLmFkZChjdXIpLCBCaWdOdW1iZXIuZnJvbSgwKSlcbiAgICAgICAgICAgICAgY29uc3QgYW1vdW50T3V0ID0gQmlnTnVtYmVyLmZyb20oZGF0YS5xdW90ZSlcbiAgICAgICAgICAgICAgZXhwZWN0KGFtb3VudE91dC5lcShhbW91bnRPdXRFZGdlc1RvdGFsKSlcblxuICAgICAgICAgICAgICBjb25zdCB7IHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgdG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIgfSA9IGF3YWl0IGV4ZWN1dGVTd2FwKFxuICAgICAgICAgICAgICAgIGRhdGEubWV0aG9kUGFyYW1ldGVycyEsXG4gICAgICAgICAgICAgICAgVVNEQ19NQUlOTkVULFxuICAgICAgICAgICAgICAgIEV0aGVyLm9uQ2hhaW4oMSlcbiAgICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICAgIGV4cGVjdCh0b2tlbkluQmVmb3JlLnN1YnRyYWN0KHRva2VuSW5BZnRlcikudG9FeGFjdCgpKS50by5lcXVhbCgnMTAwMDAwMCcpXG4gICAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKFxuICAgICAgICAgICAgICAgICAgdG9rZW5PdXRCZWZvcmUsXG4gICAgICAgICAgICAgICAgICB0b2tlbk91dEFmdGVyLFxuICAgICAgICAgICAgICAgICAgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChFdGhlci5vbkNoYWluKDEpLCBkYXRhLnF1b3RlKVxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBIYXJkIHRvIHRlc3QgRVRIIGJhbGFuY2UgZHVlIHRvIGdhcyBjb3N0cyBmb3IgYXBwcm92YWwgYW5kIHN3YXAuIEp1c3QgY2hlY2sgdG9rZW5JbiBjaGFuZ2VzXG4gICAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChVU0RDX01BSU5ORVQsIGRhdGEucXVvdGUpKVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICBpdChgZXRoIC0+IGVyYzIwYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ0VUSCcsXG4gICAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVU5JJyxcbiAgICAgICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICAgICAgYW1vdW50OlxuICAgICAgICAgICAgICAgICAgdHlwZSA9PSAnZXhhY3RJbidcbiAgICAgICAgICAgICAgICAgICAgPyBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ0VUSCcsICdVTkknLCAnMTAnKVxuICAgICAgICAgICAgICAgICAgICA6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnRVRIJywgJ1VOSScsICcxMDAwMCcpLFxuICAgICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiB0eXBlID09ICdleGFjdE91dCcgPyBMQVJHRV9TTElQUEFHRSA6IFNMSVBQQUdFLCAvLyBmb3IgZXhhY3Qgb3V0IHNvbWVob3cgdGhlIGxpcXVpZGF0aW9uIHdhc24ndCBzdWZmaWNpZW50LCBoZW5jZSBoaWdoZXIgc2xpcHBhZ2VcbiAgICAgICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgICAgIHNpbXVsYXRlRnJvbUFkZHJlc3M6ICcweDA3MTZhMTdGQkFlRTcxNGYxRTZhQjBmOWQ1OWVkYkM1ZjA5ODE1QzAnLFxuICAgICAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgICBjb25zdCB7IGRhdGEsIHN0YXR1cyB9ID0gcmVzcG9uc2VcbiAgICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgICAgICBleHBlY3QoZGF0YS5zaW11bGF0aW9uRXJyb3IpLnRvLmVxdWFsKGZhbHNlKVxuICAgICAgICAgICAgICBleHBlY3QoZGF0YS5tZXRob2RQYXJhbWV0ZXJzKS50by5ub3QuYmUudW5kZWZpbmVkXG5cbiAgICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgICBkYXRhLm1ldGhvZFBhcmFtZXRlcnMhLFxuICAgICAgICAgICAgICAgIEV0aGVyLm9uQ2hhaW4oMSksXG4gICAgICAgICAgICAgICAgVU5JX01BSU5ORVRcbiAgICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICAgIC8vIFdlJ3ZlIHN3YXBwZWQgMTAgRVRIICsgZ2FzIGNvc3RzXG4gICAgICAgICAgICAgICAgZXhwZWN0KHRva2VuSW5CZWZvcmUuc3VidHJhY3QodG9rZW5JbkFmdGVyKS5ncmVhdGVyVGhhbihwYXJzZUFtb3VudCgnMTAnLCBFdGhlci5vbkNoYWluKDEpKSkpLnRvLmJlLnRydWVcbiAgICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoVU5JX01BSU5ORVQsIGRhdGEucXVvdGUpKVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGV4cGVjdCh0b2tlbk91dEFmdGVyLnN1YnRyYWN0KHRva2VuT3V0QmVmb3JlKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAwMCcpXG4gICAgICAgICAgICAgICAgLy8gQ2FuJ3QgZWFzaWx5IGNoZWNrIHNsaXBwYWdlIGZvciBFVEggZHVlIHRvIGdhcyBjb3N0cyBlZmZlY3RpbmcgRVRIIGJhbGFuY2UuXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgIGl0KGBldGggLT4gZXJjMjAgc3dhcHJvdXRlcjAyYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ0VUSCcsXG4gICAgICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVU5JJyxcbiAgICAgICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICAgICAgYW1vdW50OlxuICAgICAgICAgICAgICAgICAgdHlwZSA9PSAnZXhhY3RJbidcbiAgICAgICAgICAgICAgICAgICAgPyBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ0VUSCcsICdVTkknLCAnMTAnKVxuICAgICAgICAgICAgICAgICAgICA6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnRVRIJywgJ1VOSScsICcxMDAwMCcpLFxuICAgICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiB0eXBlID09ICdleGFjdE91dCcgPyBMQVJHRV9TTElQUEFHRSA6IFNMSVBQQUdFLCAvLyBmb3IgZXhhY3Qgb3V0IHNvbWVob3cgdGhlIGxpcXVpZGF0aW9uIHdhc24ndCBzdWZmaWNpZW50LCBoZW5jZSBoaWdoZXIgc2xpcHBhZ2UsXG4gICAgICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgICAgICBzaW11bGF0ZUZyb21BZGRyZXNzOiAnMHgwMDAwMDAwMDIxOWFiNTQwMzU2Y0JCODM5Q2JlMDUzMDNkNzcwNUZhJyxcbiAgICAgICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IGZhbHNlLFxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgICAgICAgICAgIGNvbnN0IHsgZGF0YSwgc3RhdHVzIH0gPSByZXNwb25zZVxuICAgICAgICAgICAgICBleHBlY3Qoc3RhdHVzKS50by5lcXVhbCgyMDApXG4gICAgICAgICAgICAgIGV4cGVjdChkYXRhLm1ldGhvZFBhcmFtZXRlcnMpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgICBjb25zdCB7IHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgdG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIgfSA9IGF3YWl0IGV4ZWN1dGVTd2FwKFxuICAgICAgICAgICAgICAgIGRhdGEubWV0aG9kUGFyYW1ldGVycyEsXG4gICAgICAgICAgICAgICAgRXRoZXIub25DaGFpbigxKSxcbiAgICAgICAgICAgICAgICBVTklfTUFJTk5FVFxuICAgICAgICAgICAgICApXG5cbiAgICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgLy8gV2UndmUgc3dhcHBlZCAxMCBFVEggKyBnYXMgY29zdHNcbiAgICAgICAgICAgICAgICBleHBlY3QodG9rZW5JbkJlZm9yZS5zdWJ0cmFjdCh0b2tlbkluQWZ0ZXIpLmdyZWF0ZXJUaGFuKHBhcnNlQW1vdW50KCcxMCcsIEV0aGVyLm9uQ2hhaW4oMSkpKSkudG8uYmUudHJ1ZVxuICAgICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbk91dEJlZm9yZSwgdG9rZW5PdXRBZnRlciwgQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChVTklfTUFJTk5FVCwgZGF0YS5xdW90ZSkpXG4gICAgICAgICAgICAgICAgZXhwZWN0KGRhdGEuc2ltdWxhdGlvbkVycm9yKS50by5lcXVhbChmYWxzZSlcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBleHBlY3QodG9rZW5PdXRBZnRlci5zdWJ0cmFjdCh0b2tlbk91dEJlZm9yZSkudG9FeGFjdCgpKS50by5lcXVhbCgnMTAwMDAnKVxuICAgICAgICAgICAgICAgIC8vIENhbid0IGVhc2lseSBjaGVjayBzbGlwcGFnZSBmb3IgRVRIIGR1ZSB0byBnYXMgY29zdHMgZWZmZWN0aW5nIEVUSCBiYWxhbmNlLlxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICBpdChgd2V0aCAtPiBlcmMyMGAsIGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdXRVRIJyxcbiAgICAgICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6ICdEQUknLFxuICAgICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgICBhbW91bnQ6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnV0VUSCcsICdEQUknLCAnMTAwJyksXG4gICAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgICByZWNpcGllbnQ6IGFsaWNlLmFkZHJlc3MsXG4gICAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgICAgICBhbGdvcml0aG0sXG4gICAgICAgICAgICAgICAgc2ltdWxhdGVGcm9tQWRkcmVzczogJzB4ZjA0YTVjYzgwYjFlOTRjNjliNDhmNWVlNjhhMDhjZDJmMDlhN2MzZScsXG4gICAgICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgICAgICAgICAgIGNvbnN0IHsgZGF0YSwgc3RhdHVzIH0gPSByZXNwb25zZVxuICAgICAgICAgICAgICBleHBlY3Qoc3RhdHVzKS50by5lcXVhbCgyMDApXG4gICAgICAgICAgICAgIGV4cGVjdChkYXRhLnNpbXVsYXRpb25FcnJvcikudG8uZXF1YWwoZmFsc2UpXG4gICAgICAgICAgICAgIGV4cGVjdChkYXRhLm1ldGhvZFBhcmFtZXRlcnMpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgICBjb25zdCB7IHRva2VuSW5CZWZvcmUsIHRva2VuSW5BZnRlciwgdG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIgfSA9IGF3YWl0IGV4ZWN1dGVTd2FwKFxuICAgICAgICAgICAgICAgIGRhdGEubWV0aG9kUGFyYW1ldGVycyEsXG4gICAgICAgICAgICAgICAgV0VUSDlbMV0hLFxuICAgICAgICAgICAgICAgIERBSV9NQUlOTkVUXG4gICAgICAgICAgICAgIClcblxuICAgICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgICBleHBlY3QodG9rZW5JbkJlZm9yZS5zdWJ0cmFjdCh0b2tlbkluQWZ0ZXIpLnRvRXhhY3QoKSkudG8uZXF1YWwoJzEwMCcpXG4gICAgICAgICAgICAgICAgY2hlY2tRdW90ZVRva2VuKHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KERBSV9NQUlOTkVULCBkYXRhLnF1b3RlKSlcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBleHBlY3QodG9rZW5PdXRBZnRlci5zdWJ0cmFjdCh0b2tlbk91dEJlZm9yZSkudG9FeGFjdCgpKS50by5lcXVhbCgnMTAwJylcbiAgICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5JbkJlZm9yZSwgdG9rZW5JbkFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KFdFVEg5WzFdISwgZGF0YS5xdW90ZSkpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgIGl0KGBlcmMyMCAtPiB3ZXRoYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ1VTREMnLFxuICAgICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ1dFVEgnLFxuICAgICAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgICAgICBhbW91bnQ6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnVVNEQycsICdXRVRIJywgJzEwMCcpLFxuICAgICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgICAgIHNpbXVsYXRlRnJvbUFkZHJlc3M6ICcweGY1ODRmODcyOGI4NzRhNmE1YzdhOGQ0ZDM4N2M5YWFlOTE3MmQ2MjEnLFxuICAgICAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgICBjb25zdCB7IGRhdGEsIHN0YXR1cyB9ID0gcmVzcG9uc2VcbiAgICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgICAgICBleHBlY3QoZGF0YS5zaW11bGF0aW9uRXJyb3IpLnRvLmVxdWFsKGZhbHNlKVxuICAgICAgICAgICAgICBleHBlY3QoZGF0YS5tZXRob2RQYXJhbWV0ZXJzKS50by5ub3QuYmUudW5kZWZpbmVkXG5cbiAgICAgICAgICAgICAgY29uc3QgeyB0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIHRva2VuT3V0QmVmb3JlLCB0b2tlbk91dEFmdGVyIH0gPSBhd2FpdCBleGVjdXRlU3dhcChcbiAgICAgICAgICAgICAgICBkYXRhLm1ldGhvZFBhcmFtZXRlcnMhLFxuICAgICAgICAgICAgICAgIFVTRENfTUFJTk5FVCxcbiAgICAgICAgICAgICAgICBXRVRIOVsxXSFcbiAgICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICAgIGV4cGVjdCh0b2tlbkluQmVmb3JlLnN1YnRyYWN0KHRva2VuSW5BZnRlcikudG9FeGFjdCgpKS50by5lcXVhbCgnMTAwJylcbiAgICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoV0VUSDlbMV0sIGRhdGEucXVvdGUpKVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGV4cGVjdCh0b2tlbk91dEFmdGVyLnN1YnRyYWN0KHRva2VuT3V0QmVmb3JlKS50b0V4YWN0KCkpLnRvLmVxdWFsKCcxMDAnKVxuICAgICAgICAgICAgICAgIGNoZWNrUXVvdGVUb2tlbih0b2tlbkluQmVmb3JlLCB0b2tlbkluQWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoVVNEQ19NQUlOTkVULCBkYXRhLnF1b3RlKSlcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSlcblxuICAgICAgICAgICAgY29uc3QgdXJhUmVmYWN0b3JJbnRlcmltU3RhdGUgPSBbJ2JlZm9yZScsICdhZnRlciddXG4gICAgICAgICAgICBHUkVFTkxJU1RfVE9LRU5fUEFJUlMuZm9yRWFjaCgoW3Rva2VuSW4sIHRva2VuT3V0XSkgPT4ge1xuICAgICAgICAgICAgICB1cmFSZWZhY3RvckludGVyaW1TdGF0ZS5mb3JFYWNoKChzdGF0ZSkgPT4ge1xuICAgICAgICAgICAgICAgIGl0KGAke3Rva2VuSW4uc3ltYm9sfSAtPiAke3Rva2VuT3V0LnN5bWJvbH0gd2l0aCBwb3J0aW9uLCBzdGF0ZSA9ICR7c3RhdGV9YCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgY29uc3Qgb3JpZ2luYWxBbW91bnQgPSAnMTAnXG4gICAgICAgICAgICAgICAgICBjb25zdCB0b2tlbkluU3ltYm9sID0gdG9rZW5Jbi5zeW1ib2whXG4gICAgICAgICAgICAgICAgICBjb25zdCB0b2tlbk91dFN5bWJvbCA9IHRva2VuT3V0LnN5bWJvbCFcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHRva2VuSW5BZGRyZXNzID0gdG9rZW5Jbi5pc05hdGl2ZSA/IHRva2VuSW5TeW1ib2wgOiB0b2tlbkluLmFkZHJlc3NcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHRva2VuT3V0QWRkcmVzcyA9IHRva2VuT3V0LmlzTmF0aXZlID8gdG9rZW5PdXRTeW1ib2wgOiB0b2tlbk91dC5hZGRyZXNzXG4gICAgICAgICAgICAgICAgICBjb25zdCBhbW91bnQgPSBhd2FpdCBnZXRBbW91bnRGcm9tVG9rZW4odHlwZSwgdG9rZW5Jbi53cmFwcGVkLCB0b2tlbk91dC53cmFwcGVkLCBvcmlnaW5hbEFtb3VudClcblxuICAgICAgICAgICAgICAgICAgLy8gd2UgbmVlZCB0byBzaW11bGF0ZSBVUkEgYmVmb3JlIGFuZCBhZnRlciBtZXJnaW5nIGh0dHBzOi8vZ2l0aHViLmNvbS9Vbmlzd2FwL3VuaWZpZWQtcm91dGluZy1hcGkvcHVsbC8yODIgaW50ZXJpbSBzdGF0ZXNcbiAgICAgICAgICAgICAgICAgIC8vIHRvIGVuc3VyZSByb3V0aW5nLWFwaSBpcyBiYWNrd2FyZCBjb21wYXRpYmxlIHdpdGggVVJBXG4gICAgICAgICAgICAgICAgICBsZXQgcG9ydGlvbkJpcHMgPSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgIGlmIChzdGF0ZSA9PT0gJ2JlZm9yZScgJiYgdHlwZSA9PT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHBvcnRpb25CaXBzID0gRkxBVF9QT1JUSU9OLmJpcHNcbiAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc3RhdGUgPT09ICdhZnRlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgcG9ydGlvbkJpcHMgPSBGTEFUX1BPUlRJT04uYmlwc1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgbGV0IHBvcnRpb25BbW91bnQgPSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgIGlmIChzdGF0ZSA9PT0gJ2JlZm9yZScgJiYgdHlwZSA9PT0gJ2V4YWN0T3V0Jykge1xuICAgICAgICAgICAgICAgICAgICBwb3J0aW9uQW1vdW50ID0gQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudCh0b2tlbk91dCwgYW1vdW50KVxuICAgICAgICAgICAgICAgICAgICAgIC5tdWx0aXBseShuZXcgRnJhY3Rpb24oRkxBVF9QT1JUSU9OLmJpcHMsIDEwXzAwMCkpXG4gICAgICAgICAgICAgICAgICAgICAgLnF1b3RpZW50LnRvU3RyaW5nKClcbiAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc3RhdGUgPT09ICdhZnRlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYWZ0ZXIgVVJBIG1lcmdlcyBodHRwczovL2dpdGh1Yi5jb20vVW5pc3dhcC91bmlmaWVkLXJvdXRpbmctYXBpL3B1bGwvMjgyLFxuICAgICAgICAgICAgICAgICAgICAvLyBpdCBubyBsb25nZXIgc2VuZHMgcG9ydGlvbkFtb3VudFxuICAgICAgICAgICAgICAgICAgICBwb3J0aW9uQW1vdW50ID0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgICAgICAgICB0b2tlbkluQWRkcmVzczogdG9rZW5JbkFkZHJlc3MsXG4gICAgICAgICAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiB0b2tlbkluLmNoYWluSWQsXG4gICAgICAgICAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogdG9rZW5PdXRBZGRyZXNzLFxuICAgICAgICAgICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IHRva2VuT3V0LmNoYWluSWQsXG4gICAgICAgICAgICAgICAgICAgIGFtb3VudDogYW1vdW50LFxuICAgICAgICAgICAgICAgICAgICB0eXBlOiB0eXBlLFxuICAgICAgICAgICAgICAgICAgICBwcm90b2NvbHM6ICd2Mix2MyxtaXhlZCcsXG4gICAgICAgICAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBzaW11bGF0ZUZyb21BZGRyZXNzOiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgICAgICAgICBwb3J0aW9uQmlwczogcG9ydGlvbkJpcHMsXG4gICAgICAgICAgICAgICAgICAgIHBvcnRpb25BbW91bnQ6IHBvcnRpb25BbW91bnQsXG4gICAgICAgICAgICAgICAgICAgIHBvcnRpb25SZWNpcGllbnQ6IEZMQVRfUE9SVElPTi5yZWNpcGllbnQsXG4gICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZTogQXhpb3NSZXNwb25zZTxRdW90ZVJlc3BvbnNlPiA9IGF3YWl0IGF4aW9zLmdldDxRdW90ZVJlc3BvbnNlPihgJHtBUEl9PyR7cXVlcnlQYXJhbXN9YClcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHsgZGF0YSwgc3RhdHVzIH0gPSByZXNwb25zZVxuICAgICAgICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgICAgICAgICAgZXhwZWN0KGRhdGEuc2ltdWxhdGlvbkVycm9yKS50by5lcXVhbChmYWxzZSlcbiAgICAgICAgICAgICAgICAgIGV4cGVjdChkYXRhLm1ldGhvZFBhcmFtZXRlcnMpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgICAgICAgZXhwZWN0KGRhdGEucG9ydGlvblJlY2lwaWVudCkudG8ubm90LmJlLnVuZGVmaW5lZFxuXG4gICAgICAgICAgICAgICAgICBpZiAoIShzdGF0ZSA9PT0gJ2JlZm9yZScgJiYgdHlwZSA9PT0gJ2V4YWN0T3V0JykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYmVmb3JlIFVSQSBpbnRlcmltIHN0YXRlIGl0IGRvZXNudCBzZW5kIHBvcnRpb25CaXBzIHRvIHJvdXRpbmctYXBpLFxuICAgICAgICAgICAgICAgICAgICAvLyBzbyByb3V0aW5nLWFwaSBoYXMgbm8gd2F5IHRvIGtub3cgdGhlIHBvcnRpb25CaXBzXG4gICAgICAgICAgICAgICAgICAgIGV4cGVjdChkYXRhLnBvcnRpb25CaXBzKS50by5ub3QuYmUudW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgIGV4cGVjdChkYXRhLnBvcnRpb25CaXBzKS50by5lcXVhbChGTEFUX1BPUlRJT04uYmlwcylcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgIGV4cGVjdChkYXRhLnBvcnRpb25BbW91bnQpLnRvLm5vdC5iZS51bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgIGV4cGVjdChkYXRhLnBvcnRpb25BbW91bnREZWNpbWFscykudG8ubm90LmJlLnVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgZXhwZWN0KGRhdGEucXVvdGVHYXNBbmRQb3J0aW9uQWRqdXN0ZWQpLnRvLm5vdC5iZS51bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgIGV4cGVjdChkYXRhLnF1b3RlR2FzQW5kUG9ydGlvbkFkanVzdGVkRGVjaW1hbHMpLnRvLm5vdC5iZS51bmRlZmluZWRcblxuICAgICAgICAgICAgICAgICAgZXhwZWN0KGRhdGEucG9ydGlvblJlY2lwaWVudCkudG8uZXF1YWwoRkxBVF9QT1JUSU9OLnJlY2lwaWVudClcblxuICAgICAgICAgICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGFsbFF1b3Rlc0Fjcm9zc1JvdXRlcyA9IGRhdGEucm91dGVcbiAgICAgICAgICAgICAgICAgICAgICAubWFwKChyb3V0ZXMpID0+XG4gICAgICAgICAgICAgICAgICAgICAgICByb3V0ZXNcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLm1hcCgocm91dGUpID0+IHJvdXRlLmFtb3VudE91dClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLm1hcCgoYW1vdW50T3V0KSA9PiBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KHRva2VuT3V0LCBhbW91bnRPdXQgPz8gJzAnKSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLnJlZHVjZSgoY3VyLCB0b3RhbCkgPT4gdG90YWwuYWRkKGN1ciksIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQodG9rZW5PdXQsICcwJykpXG4gICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgIC5yZWR1Y2UoKGN1ciwgdG90YWwpID0+IHRvdGFsLmFkZChjdXIpLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KHRva2VuT3V0LCAnMCcpKVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHF1b3RlID0gQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudCh0b2tlbk91dCwgZGF0YS5xdW90ZSlcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZXhwZWN0ZWRQb3J0aW9uQW1vdW50ID0gcXVvdGUubXVsdGlwbHkobmV3IEZyYWN0aW9uKEZMQVRfUE9SVElPTi5iaXBzLCAxMDAwMCkpXG4gICAgICAgICAgICAgICAgICAgIGV4cGVjdChkYXRhLnBvcnRpb25BbW91bnQpLnRvLmVxdWFsKGV4cGVjdGVkUG9ydGlvbkFtb3VudC5xdW90aWVudC50b1N0cmluZygpKVxuXG4gICAgICAgICAgICAgICAgICAgIC8vIFRoZSBtb3N0IHN0cmljdCB3YXkgdG8gZW5zdXJlIHRoZSBvdXRwdXQgYW1vdW50IGZyb20gcm91dGUgcGF0aCBpcyBjb3JyZWN0IHdpdGggcmVzcGVjdCB0byBwb3J0aW9uXG4gICAgICAgICAgICAgICAgICAgIC8vIGlzIHRvIG1ha2Ugc3VyZSB0aGUgb3V0cHV0IGFtb3VudCBmcm9tIHJvdXRlIHBhdGggaXMgZXhhY3RseSBwb3J0aW9uIGJwcyBkaWZmZXJlbnQgZnJvbSB0aGUgcXVvdGVcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdG9rZW5zRGlmZiA9IHF1b3RlLnN1YnRyYWN0KGFsbFF1b3Rlc0Fjcm9zc1JvdXRlcylcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcGVyY2VudERpZmYgPSB0b2tlbnNEaWZmLmFzRnJhY3Rpb24uZGl2aWRlKHF1b3RlLmFzRnJhY3Rpb24pXG4gICAgICAgICAgICAgICAgICAgIGV4cGVjdChwZXJjZW50RGlmZi5xdW90aWVudC50b1N0cmluZygpKS5lcXVhbChcbiAgICAgICAgICAgICAgICAgICAgICBuZXcgRnJhY3Rpb24oRkxBVF9QT1JUSU9OLmJpcHMsIDEwXzAwMCkucXVvdGllbnQudG9TdHJpbmcoKVxuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBhbGxRdW90ZXNBY3Jvc3NSb3V0ZXMgPSBkYXRhLnJvdXRlXG4gICAgICAgICAgICAgICAgICAgICAgLm1hcCgocm91dGVzKSA9PlxuICAgICAgICAgICAgICAgICAgICAgICAgcm91dGVzXG4gICAgICAgICAgICAgICAgICAgICAgICAgIC5tYXAoKHJvdXRlKSA9PiByb3V0ZS5hbW91bnRPdXQpXG4gICAgICAgICAgICAgICAgICAgICAgICAgIC5tYXAoKGFtb3VudE91dCkgPT4gQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudCh0b2tlbkluLCBhbW91bnRPdXQgPz8gJzAnKSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLnJlZHVjZSgoY3VyLCB0b3RhbCkgPT4gdG90YWwuYWRkKGN1ciksIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQodG9rZW5JbiwgJzAnKSlcbiAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgLnJlZHVjZSgoY3VyLCB0b3RhbCkgPT4gdG90YWwuYWRkKGN1ciksIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQodG9rZW5JbiwgJzAnKSlcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcXVvdGUgPSBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KHRva2VuSW4sIGRhdGEucXVvdGUpXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGV4cGVjdGVkUG9ydGlvbkFtb3VudCA9IEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQodG9rZW5PdXQsIGFtb3VudCkubXVsdGlwbHkoXG4gICAgICAgICAgICAgICAgICAgICAgbmV3IEZyYWN0aW9uKEZMQVRfUE9SVElPTi5iaXBzLCAxMDAwMClcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICBleHBlY3QoZGF0YS5wb3J0aW9uQW1vdW50KS50by5lcXVhbChleHBlY3RlZFBvcnRpb25BbW91bnQucXVvdGllbnQudG9TdHJpbmcoKSlcblxuICAgICAgICAgICAgICAgICAgICAvLyBUaGUgbW9zdCBzdHJpY3Qgd2F5IHRvIGVuc3VyZSB0aGUgb3V0cHV0IGFtb3VudCBmcm9tIHJvdXRlIHBhdGggaXMgY29ycmVjdCB3aXRoIHJlc3BlY3QgdG8gcG9ydGlvblxuICAgICAgICAgICAgICAgICAgICAvLyBpcyB0byBtYWtlIHN1cmUgdGhlIG91dHB1dCBhbW91bnQgZnJvbSByb3V0ZSBwYXRoIGlzIGV4YWN0bHkgcG9ydGlvbiBicHMgZGlmZmVyZW50IGZyb20gdGhlIHF1b3RlXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHRva2Vuc0RpZmYgPSBhbGxRdW90ZXNBY3Jvc3NSb3V0ZXMuc3VidHJhY3QocXVvdGUpXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHBlcmNlbnREaWZmID0gdG9rZW5zRGlmZi5hc0ZyYWN0aW9uLmRpdmlkZShxdW90ZS5hc0ZyYWN0aW9uKVxuICAgICAgICAgICAgICAgICAgICBleHBlY3QocGVyY2VudERpZmYucXVvdGllbnQudG9TdHJpbmcoKSkuZXF1YWwoXG4gICAgICAgICAgICAgICAgICAgICAgbmV3IEZyYWN0aW9uKEZMQVRfUE9SVElPTi5iaXBzLCAxMF8wMDApLnF1b3RpZW50LnRvU3RyaW5nKClcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICAgICAgICAgIHRva2VuSW5CZWZvcmUsXG4gICAgICAgICAgICAgICAgICAgIHRva2VuSW5BZnRlcixcbiAgICAgICAgICAgICAgICAgICAgdG9rZW5PdXRCZWZvcmUsXG4gICAgICAgICAgICAgICAgICAgIHRva2VuT3V0QWZ0ZXIsXG4gICAgICAgICAgICAgICAgICAgIHRva2VuT3V0UG9ydGlvblJlY2lwaWVudEJlZm9yZSxcbiAgICAgICAgICAgICAgICAgICAgdG9rZW5PdXRQb3J0aW9uUmVjaXBpZW50QWZ0ZXIsXG4gICAgICAgICAgICAgICAgICB9ID0gYXdhaXQgZXhlY3V0ZVN3YXAoXG4gICAgICAgICAgICAgICAgICAgIGRhdGEubWV0aG9kUGFyYW1ldGVycyEsXG4gICAgICAgICAgICAgICAgICAgIHRva2VuSW4sXG4gICAgICAgICAgICAgICAgICAgIHRva2VuT3V0ISxcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIHRva2VuSW4uY2hhaW5JZCxcbiAgICAgICAgICAgICAgICAgICAgRkxBVF9QT1JUSU9OXG4gICAgICAgICAgICAgICAgICApXG5cbiAgICAgICAgICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgdG9rZW4gaW4gaXMgbmF0aXZlIHRva2VuLCB0aGUgZGlmZmVyZW5jZSB3aWxsIGJlIHNsaWdodGx5IGxhcmdlciBkdWUgdG8gZ2FzLiBXZSBoYXZlIG5vIHdheSB0byBrbm93IHByZWNpc2UgZ2FzIGNvc3RzIGluIHRlcm1zIG9mIEdXRUkgKiBnYXMgdW5pdHMuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdG9rZW5Jbi5pc05hdGl2ZSkge1xuICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdCh0b2tlbkluQmVmb3JlLnN1YnRyYWN0KHRva2VuSW5BZnRlcikudG9FeGFjdCgpKS50by5lcXVhbChvcmlnaW5hbEFtb3VudClcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZSB0b2tlbiBvdXQgaXMgbmF0aXZlIHRva2VuLCB0aGUgZGlmZmVyZW5jZSB3aWxsIGJlIHNsaWdodGx5IGxhcmdlciBkdWUgdG8gZ2FzLiBXZSBoYXZlIG5vIHdheSB0byBrbm93IHByZWNpc2UgZ2FzIGNvc3RzIGluIHRlcm1zIG9mIEdXRUkgKiBnYXMgdW5pdHMuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdG9rZW5PdXQuaXNOYXRpdmUpIHtcbiAgICAgICAgICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5PdXRCZWZvcmUsIHRva2VuT3V0QWZ0ZXIsIEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQodG9rZW5PdXQsIGRhdGEucXVvdGUpKVxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgZXhwZWN0KGRhdGEucG9ydGlvbkFtb3VudCkubm90LnRvLmJlLnVuZGVmaW5lZFxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGV4cGVjdGVkUG9ydGlvbkFtb3VudCA9IEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQodG9rZW5PdXQsIGRhdGEucG9ydGlvbkFtb3VudCEpXG4gICAgICAgICAgICAgICAgICAgIGNoZWNrUG9ydGlvblJlY2lwaWVudFRva2VuKFxuICAgICAgICAgICAgICAgICAgICAgIHRva2VuT3V0UG9ydGlvblJlY2lwaWVudEJlZm9yZSEsXG4gICAgICAgICAgICAgICAgICAgICAgdG9rZW5PdXRQb3J0aW9uUmVjaXBpZW50QWZ0ZXIhLFxuICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdGVkUG9ydGlvbkFtb3VudFxuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgdG9rZW4gb3V0IGlzIG5hdGl2ZSB0b2tlbiwgdGhlIGRpZmZlcmVuY2Ugd2lsbCBiZSBzbGlnaHRseSBsYXJnZXIgZHVlIHRvIGdhcy4gV2UgaGF2ZSBubyB3YXkgdG8ga25vdyBwcmVjaXNlIGdhcyBjb3N0cyBpbiB0ZXJtcyBvZiBHV0VJICogZ2FzIHVuaXRzLlxuICAgICAgICAgICAgICAgICAgICBpZiAoIXRva2VuT3V0LmlzTmF0aXZlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgZXhwZWN0KHRva2VuT3V0QWZ0ZXIuc3VidHJhY3QodG9rZW5PdXRCZWZvcmUpLnRvRXhhY3QoKSkudG8uZXF1YWwob3JpZ2luYWxBbW91bnQpXG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgdG9rZW4gb3V0IGlzIG5hdGl2ZSB0b2tlbiwgdGhlIGRpZmZlcmVuY2Ugd2lsbCBiZSBzbGlnaHRseSBsYXJnZXIgZHVlIHRvIGdhcy4gV2UgaGF2ZSBubyB3YXkgdG8ga25vdyBwcmVjaXNlIGdhcyBjb3N0cyBpbiB0ZXJtcyBvZiBHV0VJICogZ2FzIHVuaXRzLlxuICAgICAgICAgICAgICAgICAgICBpZiAoIXRva2VuSW4uaXNOYXRpdmUpIHtcbiAgICAgICAgICAgICAgICAgICAgICBjaGVja1F1b3RlVG9rZW4odG9rZW5JbkJlZm9yZSwgdG9rZW5JbkFmdGVyLCBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KHRva2VuSW4sIGRhdGEucXVvdGUpKVxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgZXhwZWN0KGRhdGEucG9ydGlvbkFtb3VudCkubm90LnRvLmJlLnVuZGVmaW5lZFxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGV4cGVjdGVkUG9ydGlvbkFtb3VudCA9IEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQodG9rZW5PdXQsIGRhdGEucG9ydGlvbkFtb3VudCEpXG4gICAgICAgICAgICAgICAgICAgIGNoZWNrUG9ydGlvblJlY2lwaWVudFRva2VuKFxuICAgICAgICAgICAgICAgICAgICAgIHRva2VuT3V0UG9ydGlvblJlY2lwaWVudEJlZm9yZSEsXG4gICAgICAgICAgICAgICAgICAgICAgdG9rZW5PdXRQb3J0aW9uUmVjaXBpZW50QWZ0ZXIhLFxuICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdGVkUG9ydGlvbkFtb3VudFxuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgICAgICBpdChgZXJjMjAgLT4gZXJjMjAgbm8gcmVjaXBpZW50L2RlYWRsaW5lL3NsaXBwYWdlYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RDJyxcbiAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEVCcsXG4gICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICBhbW91bnQ6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnVVNEQycsICdVU0RUJywgJzEwMCcpLFxuICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHFzLnN0cmluZ2lmeShxdW90ZVJlcSlcblxuICAgICAgICAgIGNvbnN0IHJlc3BvbnNlOiBBeGlvc1Jlc3BvbnNlPFF1b3RlUmVzcG9uc2U+ID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgIGNvbnN0IHtcbiAgICAgICAgICAgIGRhdGE6IHsgcXVvdGVEZWNpbWFscywgcXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzLCBtZXRob2RQYXJhbWV0ZXJzIH0sXG4gICAgICAgICAgICBzdGF0dXMsXG4gICAgICAgICAgfSA9IHJlc3BvbnNlXG5cbiAgICAgICAgICBleHBlY3Qoc3RhdHVzKS50by5lcXVhbCgyMDApXG4gICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpLnRvLmJlLmdyZWF0ZXJUaGFuKDkwKVxuICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbigxMTApXG5cbiAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscykpLnRvLmJlLmxlc3NUaGFuT3JFcXVhbChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBleHBlY3QobWV0aG9kUGFyYW1ldGVycykudG8uYmUudW5kZWZpbmVkXG4gICAgICAgIH0pXG5cbiAgICAgICAgaXQoYG9uZSBvZiByZWNpcGllbnQvZGVhZGxpbmUvc2xpcHBhZ2UgaXMgbWlzc2luZ2AsIGFzeW5jICgpID0+IHtcbiAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiAnVVNEQycsXG4gICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogMSxcbiAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ1VTRFQnLFxuICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiAxLFxuICAgICAgICAgICAgYW1vdW50OiBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ1VTREMnLCAnVVNEVCcsICcxMDAnKSxcbiAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICBzbGlwcGFnZVRvbGVyYW5jZTogU0xJUFBBR0UsXG4gICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICBhbGdvcml0aG0sXG4gICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IHRydWUsXG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgY29uc3QgcmVzcG9uc2U6IEF4aW9zUmVzcG9uc2U8UXVvdGVSZXNwb25zZT4gPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgICAgICAgY29uc3Qge1xuICAgICAgICAgICAgZGF0YTogeyBxdW90ZURlY2ltYWxzLCBxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMsIG1ldGhvZFBhcmFtZXRlcnMgfSxcbiAgICAgICAgICAgIHN0YXR1cyxcbiAgICAgICAgICB9ID0gcmVzcG9uc2VcblxuICAgICAgICAgIGV4cGVjdChzdGF0dXMpLnRvLmVxdWFsKDIwMClcbiAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW4oOTApXG4gICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpLnRvLmJlLmxlc3NUaGFuKDExMClcblxuICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUubGVzc1RoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscykpLnRvLmJlLmdyZWF0ZXJUaGFuT3JFcXVhbChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFNpbmNlIHVyLXNkayBoYXJkY29kZXMgcmVjaXBpZW50IGluIGNhc2Ugb2Ygbm8gcmVjaXBpZW50IGh0dHBzOi8vZ2l0aHViLmNvbS9Vbmlzd2FwL3VuaXZlcnNhbC1yb3V0ZXItc2RrL2Jsb2IvbWFpbi9zcmMvZW50aXRpZXMvcHJvdG9jb2xzL3VuaXN3YXAudHMjTDY4XG4gICAgICAgICAgLy8gdGhlIGNhbGxkYXRhIHdpbGwgc3RpbGwgZ2V0IGdlbmVyYXRlZCBldmVuIGlmIFVSQSBkb2Vzbid0IHBhc3MgaW4gcmVjaXBpZW50XG4gICAgICAgICAgZXhwZWN0KG1ldGhvZFBhcmFtZXRlcnMpLm5vdC50by5iZS51bmRlZmluZWRcbiAgICAgICAgfSlcblxuICAgICAgICBpdChgZXJjMjAgLT4gZXJjMjAgZ2FzIHByaWNlIHNwZWNpZmllZGAsIGFzeW5jICgpID0+IHtcbiAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiAnVVNEQycsXG4gICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogMSxcbiAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ1VTRFQnLFxuICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiAxLFxuICAgICAgICAgICAgYW1vdW50OiBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ1VTREMnLCAnVVNEVCcsICcxMDAnKSxcbiAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICBhbGdvcml0aG0sXG4gICAgICAgICAgICBnYXNQcmljZVdlaTogJzYwMDAwMDAwMDAwJyxcbiAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHFzLnN0cmluZ2lmeShxdW90ZVJlcSlcblxuICAgICAgICAgIGNvbnN0IHJlc3BvbnNlOiBBeGlvc1Jlc3BvbnNlPFF1b3RlUmVzcG9uc2U+ID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgIGNvbnN0IHtcbiAgICAgICAgICAgIGRhdGE6IHsgcXVvdGVEZWNpbWFscywgcXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzLCBtZXRob2RQYXJhbWV0ZXJzLCBnYXNQcmljZVdlaSB9LFxuICAgICAgICAgICAgc3RhdHVzLFxuICAgICAgICAgIH0gPSByZXNwb25zZVxuXG4gICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuXG4gICAgICAgICAgaWYgKGFsZ29yaXRobSA9PSAnYWxwaGEnKSB7XG4gICAgICAgICAgICBleHBlY3QoZ2FzUHJpY2VXZWkpLnRvLmVxdWFsKCc2MDAwMDAwMDAwMCcpXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpLnRvLmJlLmdyZWF0ZXJUaGFuKDkwKVxuICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbigxMTApXG5cbiAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscykpLnRvLmJlLmxlc3NUaGFuT3JFcXVhbChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBleHBlY3QobWV0aG9kUGFyYW1ldGVycykudG8uYmUudW5kZWZpbmVkXG4gICAgICAgIH0pXG5cbiAgICAgICAgaXQoYGVyYzIwIC0+IGVyYzIwIGJ5IGFkZHJlc3NgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJzB4NkIxNzU0NzRFODkwOTRDNDREYTk4Yjk1NEVlZGVBQzQ5NTI3MWQwRicsXG4gICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogMSwgLy8gREFJXG4gICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6ICcweEEwYjg2OTkxYzYyMThiMzZjMWQxOUQ0YTJlOUViMGNFMzYwNmVCNDgnLFxuICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiAxLCAvLyBVU0RDXG4gICAgICAgICAgICBhbW91bnQ6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnREFJJywgJ1VTREMnLCAnMTAwJyksXG4gICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgY29uc3QgcmVzcG9uc2U6IEF4aW9zUmVzcG9uc2U8UXVvdGVSZXNwb25zZT4gPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG5cbiAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICBkYXRhOiB7IHF1b3RlRGVjaW1hbHMsIHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscyB9LFxuICAgICAgICAgICAgc3RhdHVzLFxuICAgICAgICAgIH0gPSByZXNwb25zZVxuXG4gICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbig5MClcblxuICAgICAgICAgIGlmICh0eXBlID09ICdleGFjdEluJykge1xuICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUubGVzc1RoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlR2FzQWRqdXN0ZWREZWNpbWFscykpLnRvLmJlLmdyZWF0ZXJUaGFuT3JFcXVhbChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGV4cGVjdChwYXJzZUZsb2F0KHF1b3RlRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbigxMTApXG4gICAgICAgIH0pXG5cbiAgICAgICAgaXQoYGVyYzIwIC0+IGVyYzIwIG9uZSBieSBhZGRyZXNzIG9uZSBieSBzeW1ib2xgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJzB4NkIxNzU0NzRFODkwOTRDNDREYTk4Yjk1NEVlZGVBQzQ5NTI3MWQwRicsXG4gICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogMSxcbiAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogJ1VTREMnLFxuICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiAxLFxuICAgICAgICAgICAgYW1vdW50OiBhd2FpdCBnZXRBbW91bnQoMSwgdHlwZSwgJ0RBSScsICdVU0RDJywgJzEwMCcpLFxuICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHFzLnN0cmluZ2lmeShxdW90ZVJlcSlcblxuICAgICAgICAgIGNvbnN0IHJlc3BvbnNlOiBBeGlvc1Jlc3BvbnNlPFF1b3RlUmVzcG9uc2U+ID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgIGNvbnN0IHtcbiAgICAgICAgICAgIGRhdGE6IHsgcXVvdGVEZWNpbWFscywgcXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzIH0sXG4gICAgICAgICAgICBzdGF0dXMsXG4gICAgICAgICAgfSA9IHJlc3BvbnNlXG5cbiAgICAgICAgICBleHBlY3Qoc3RhdHVzKS50by5lcXVhbCgyMDApXG4gICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpLnRvLmJlLmdyZWF0ZXJUaGFuKDkwKVxuXG4gICAgICAgICAgaWYgKHR5cGUgPT0gJ2V4YWN0SW4nKSB7XG4gICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5sZXNzVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUuZ3JlYXRlclRoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpLnRvLmJlLmxlc3NUaGFuKDExMClcbiAgICAgICAgfSlcbiAgICAgIH0pXG5cbiAgICAgIGRlc2NyaWJlKGAke0lEX1RPX05FVFdPUktfTkFNRSgxKX0gJHthbGdvcml0aG19ICR7dHlwZX0gNHh4YCwgKCkgPT4ge1xuICAgICAgICBpdChgZmllbGQgaXMgbWlzc2luZyBpbiBib2R5YCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBQYXJ0aWFsPFF1b3RlUXVlcnlQYXJhbXM+ID0ge1xuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEVCcsXG4gICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogMSxcbiAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RDJywgJ1VTRFQnLCAnMTAwJyksXG4gICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIGF3YWl0IGNhbGxBbmRFeHBlY3RGYWlsKHF1b3RlUmVxLCB7XG4gICAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgICAgZGV0YWlsOiAnXCJ0b2tlbkluQWRkcmVzc1wiIGlzIHJlcXVpcmVkJyxcbiAgICAgICAgICAgICAgZXJyb3JDb2RlOiAnVkFMSURBVElPTl9FUlJPUicsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pXG4gICAgICAgIH0pXG5cbiAgICAgICAgaXQuc2tpcChgYW1vdW50IGlzIHRvbyBiaWcgdG8gZmluZCByb3V0ZWAsIGFzeW5jICgpID0+IHtcbiAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiAnVU5JJyxcbiAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnS05DJyxcbiAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVTkknLCAnS05DJywgJzk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTknKSxcbiAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICByZWNpcGllbnQ6ICcweDg4ZmM3NjU5NDlhMjc0MDU0ODBGMzc0QWE0OUUyMGRjQ0QzZkNmYjgnLFxuICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIGF3YWl0IGNhbGxBbmRFeHBlY3RGYWlsKHF1b3RlUmVxLCB7XG4gICAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgICAgZGV0YWlsOiAnTm8gcm91dGUgZm91bmQnLFxuICAgICAgICAgICAgICBlcnJvckNvZGU6ICdOT19ST1VURScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pXG4gICAgICAgIH0pXG5cbiAgICAgICAgaXQoYGFtb3VudCBpcyB0b28gYmlnIGZvciB1aW50MjU2YCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RDJyxcbiAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEVCcsXG4gICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICBhbW91bnQ6IGF3YWl0IGdldEFtb3VudChcbiAgICAgICAgICAgICAgMSxcbiAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgJ1VTREMnLFxuICAgICAgICAgICAgICAnVVNEVCcsXG4gICAgICAgICAgICAgICcxMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAnXG4gICAgICAgICAgICApLFxuICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBhd2FpdCBjYWxsQW5kRXhwZWN0RmFpbChxdW90ZVJlcSwge1xuICAgICAgICAgICAgc3RhdHVzOiA0MDAsXG4gICAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICAgIGRldGFpbDogJ1wiYW1vdW50XCIgbGVuZ3RoIG11c3QgYmUgbGVzcyB0aGFuIG9yIGVxdWFsIHRvIDc3IGNoYXJhY3RlcnMgbG9uZycsXG4gICAgICAgICAgICAgIGVycm9yQ29kZTogJ1ZBTElEQVRJT05fRVJST1InLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KVxuICAgICAgICB9KVxuXG4gICAgICAgIGl0KGBhbW91bnQgaXMgbmVnYXRpdmVgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ1VTREMnLFxuICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6ICdVU0RUJyxcbiAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgIGFtb3VudDogJy0xMDAwMDAwMDAwMCcsXG4gICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIGF3YWl0IGNhbGxBbmRFeHBlY3RGYWlsKHF1b3RlUmVxLCB7XG4gICAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgICAgZGV0YWlsOiAnXCJhbW91bnRcIiB3aXRoIHZhbHVlIFwiLTEwMDAwMDAwMDAwXCIgZmFpbHMgdG8gbWF0Y2ggdGhlIHJlcXVpcmVkIHBhdHRlcm46IC9eWzAtOV0rJC8nLFxuICAgICAgICAgICAgICBlcnJvckNvZGU6ICdWQUxJREFUSU9OX0VSUk9SJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSlcbiAgICAgICAgfSlcblxuICAgICAgICBpdChgYW1vdW50IGlzIGRlY2ltYWxgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ1VTREMnLFxuICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6ICdVU0RUJyxcbiAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgIGFtb3VudDogJzEwMDAwMDAwMDAuMjUnLFxuICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBhd2FpdCBjYWxsQW5kRXhwZWN0RmFpbChxdW90ZVJlcSwge1xuICAgICAgICAgICAgc3RhdHVzOiA0MDAsXG4gICAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICAgIGRldGFpbDogJ1wiYW1vdW50XCIgd2l0aCB2YWx1ZSBcIjEwMDAwMDAwMDAuMjVcIiBmYWlscyB0byBtYXRjaCB0aGUgcmVxdWlyZWQgcGF0dGVybjogL15bMC05XSskLycsXG4gICAgICAgICAgICAgIGVycm9yQ29kZTogJ1ZBTElEQVRJT05fRVJST1InLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KVxuICAgICAgICB9KVxuXG4gICAgICAgIGl0KGBzeW1ib2wgZG9lc250IGV4aXN0YCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RDJyxcbiAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnTk9ORVhJU1RBTlRUT0tFTicsXG4gICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICBhbW91bnQ6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnVVNEQycsICdVU0RUJywgJzEwMCcpLFxuICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBhd2FpdCBjYWxsQW5kRXhwZWN0RmFpbChxdW90ZVJlcSwge1xuICAgICAgICAgICAgc3RhdHVzOiA0MDAsXG4gICAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICAgIGRldGFpbDogJ0NvdWxkIG5vdCBmaW5kIHRva2VuIHdpdGggYWRkcmVzcyBcIk5PTkVYSVNUQU5UVE9LRU5cIicsXG4gICAgICAgICAgICAgIGVycm9yQ29kZTogJ1RPS0VOX09VVF9JTlZBTElEJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSlcbiAgICAgICAgfSlcblxuICAgICAgICBpdChgdG9rZW5zIGFyZSB0aGUgc2FtZSBzeW1ib2xgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ1VTRFQnLFxuICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDEsXG4gICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6ICdVU0RUJyxcbiAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RDJywgJ1VTRFQnLCAnMTAwJyksXG4gICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIGF3YWl0IGNhbGxBbmRFeHBlY3RGYWlsKHF1b3RlUmVxLCB7XG4gICAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgICAgZGV0YWlsOiAndG9rZW5JbiBhbmQgdG9rZW5PdXQgbXVzdCBiZSBkaWZmZXJlbnQnLFxuICAgICAgICAgICAgICBlcnJvckNvZGU6ICdUT0tFTl9JTl9PVVRfU0FNRScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pXG4gICAgICAgIH0pXG5cbiAgICAgICAgaXQoYHRva2VucyBhcmUgdGhlIHNhbWUgc3ltYm9sIGFuZCBhZGRyZXNzYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RUJyxcbiAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnMHhkQUMxN0Y5NThEMmVlNTIzYTIyMDYyMDY5OTQ1OTdDMTNEODMxZWM3JyxcbiAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RUJywgJ1VTRFQnLCAnMTAwJyksXG4gICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIGF3YWl0IGNhbGxBbmRFeHBlY3RGYWlsKHF1b3RlUmVxLCB7XG4gICAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgICAgZGV0YWlsOiAndG9rZW5JbiBhbmQgdG9rZW5PdXQgbXVzdCBiZSBkaWZmZXJlbnQnLFxuICAgICAgICAgICAgICBlcnJvckNvZGU6ICdUT0tFTl9JTl9PVVRfU0FNRScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pXG4gICAgICAgIH0pXG5cbiAgICAgICAgaXQoYHRva2VucyBhcmUgdGhlIHNhbWUgYWRkcmVzc2AsIGFzeW5jICgpID0+IHtcbiAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiAnMHhkQUMxN0Y5NThEMmVlNTIzYTIyMDYyMDY5OTQ1OTdDMTNEODMxZWM3JyxcbiAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnMHhkQUMxN0Y5NThEMmVlNTIzYTIyMDYyMDY5OTQ1OTdDMTNEODMxZWM3JyxcbiAgICAgICAgICAgIHRva2VuT3V0Q2hhaW5JZDogMSxcbiAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50KDEsIHR5cGUsICdVU0RUJywgJ1VTRFQnLCAnMTAwJyksXG4gICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgcmVjaXBpZW50OiBhbGljZS5hZGRyZXNzLFxuICAgICAgICAgICAgc2xpcHBhZ2VUb2xlcmFuY2U6IFNMSVBQQUdFLFxuICAgICAgICAgICAgZGVhZGxpbmU6ICczNjAnLFxuICAgICAgICAgICAgYWxnb3JpdGhtLFxuICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgIH1cbiAgICAgICAgICBhd2FpdCBjYWxsQW5kRXhwZWN0RmFpbChxdW90ZVJlcSwge1xuICAgICAgICAgICAgc3RhdHVzOiA0MDAsXG4gICAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICAgIGRldGFpbDogJ3Rva2VuSW4gYW5kIHRva2VuT3V0IG11c3QgYmUgZGlmZmVyZW50JyxcbiAgICAgICAgICAgICAgZXJyb3JDb2RlOiAnVE9LRU5fSU5fT1VUX1NBTUUnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KVxuICAgICAgICB9KVxuXG4gICAgICAgIGl0KGByZWNpcGllbnQgaXMgYW4gaW52YWxpZCBhZGRyZXNzYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6ICdVU0RUJyxcbiAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiAxLFxuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEQycsXG4gICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDEsXG4gICAgICAgICAgICBhbW91bnQ6IGF3YWl0IGdldEFtb3VudCgxLCB0eXBlLCAnVVNEVCcsICdVU0RDJywgJzEwMCcpLFxuICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgIHJlY2lwaWVudDogJzB4QWI1ODAxYTdEMzk4MzUxYjhiRTExQzQzOWUwNUM1QjMyNTlhWlpaWlpaWicsXG4gICAgICAgICAgICBzbGlwcGFnZVRvbGVyYW5jZTogU0xJUFBBR0UsXG4gICAgICAgICAgICBkZWFkbGluZTogJzM2MCcsXG4gICAgICAgICAgICBhbGdvcml0aG0sXG4gICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IHRydWUsXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgYXdhaXQgY2FsbEFuZEV4cGVjdEZhaWwocXVvdGVSZXEsIHtcbiAgICAgICAgICAgIHN0YXR1czogNDAwLFxuICAgICAgICAgICAgZGF0YToge1xuICAgICAgICAgICAgICBkZXRhaWw6XG4gICAgICAgICAgICAgICAgJ1wicmVjaXBpZW50XCIgd2l0aCB2YWx1ZSBcIjB4QWI1ODAxYTdEMzk4MzUxYjhiRTExQzQzOWUwNUM1QjMyNTlhWlpaWlpaWlwiIGZhaWxzIHRvIG1hdGNoIHRoZSByZXF1aXJlZCBwYXR0ZXJuOiAvXjB4W2EtZkEtRjAtOV17NDB9JC8nLFxuICAgICAgICAgICAgICBlcnJvckNvZGU6ICdWQUxJREFUSU9OX0VSUk9SJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSlcbiAgICAgICAgfSlcblxuICAgICAgICBpdChgdW5zdXBwb3J0ZWQgY2hhaW5gLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICB0b2tlbkluQWRkcmVzczogJ1VTREMnLFxuICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IDcwLFxuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiAnVVNEVCcsXG4gICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IDcwLFxuICAgICAgICAgICAgYW1vdW50OiAnMTAwMDAwMDAwMDAnLFxuICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgIHJlY2lwaWVudDogYWxpY2UuYWRkcmVzcyxcbiAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBTTElQUEFHRSxcbiAgICAgICAgICAgIGRlYWRsaW5lOiAnMzYwJyxcbiAgICAgICAgICAgIGFsZ29yaXRobSxcbiAgICAgICAgICAgIGVuYWJsZVVuaXZlcnNhbFJvdXRlcjogdHJ1ZSxcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBjaGFpbnMgPSBTVVBQT1JURURfQ0hBSU5TLnZhbHVlcygpXG4gICAgICAgICAgY29uc3QgY2hhaW5TdHIgPSBbLi4uY2hhaW5zXS50b1N0cmluZygpLnNwbGl0KCcsJykuam9pbignLCAnKVxuXG4gICAgICAgICAgYXdhaXQgY2FsbEFuZEV4cGVjdEZhaWwocXVvdGVSZXEsIHtcbiAgICAgICAgICAgIHN0YXR1czogNDAwLFxuICAgICAgICAgICAgZGF0YToge1xuICAgICAgICAgICAgICBkZXRhaWw6IGBcInRva2VuSW5DaGFpbklkXCIgbXVzdCBiZSBvbmUgb2YgWyR7Y2hhaW5TdHJ9XWAsXG4gICAgICAgICAgICAgIGVycm9yQ29kZTogJ1ZBTElEQVRJT05fRVJST1InLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KVxuICAgICAgICB9KVxuICAgICAgfSlcbiAgICB9XG4gIH1cblxuICBjb25zdCBURVNUX0VSQzIwXzE6IHsgW2NoYWluSWQgaW4gQ2hhaW5JZF06ICgpID0+IG51bGwgfCBUb2tlbiB9ID0ge1xuICAgIFtDaGFpbklkLk1BSU5ORVRdOiAoKSA9PiBVU0RDX09OKDEpLFxuICAgIFtDaGFpbklkLkdPRVJMSV06ICgpID0+IFVTRENfT04oQ2hhaW5JZC5HT0VSTEkpLFxuICAgIFtDaGFpbklkLlNFUE9MSUFdOiAoKSA9PiBVU0RDX09OKENoYWluSWQuU0VQT0xJQSksXG4gICAgW0NoYWluSWQuT1BUSU1JU01dOiAoKSA9PiBVU0RDX09OKENoYWluSWQuT1BUSU1JU00pLFxuICAgIFtDaGFpbklkLk9QVElNSVNNX0dPRVJMSV06ICgpID0+IFVTRENfT04oQ2hhaW5JZC5PUFRJTUlTTV9HT0VSTEkpLFxuICAgIFtDaGFpbklkLkFSQklUUlVNX09ORV06ICgpID0+IFVTRENfT04oQ2hhaW5JZC5BUkJJVFJVTV9PTkUpLFxuICAgIFtDaGFpbklkLlBPTFlHT05dOiAoKSA9PiBVU0RDX09OKENoYWluSWQuUE9MWUdPTiksXG4gICAgW0NoYWluSWQuUE9MWUdPTl9NVU1CQUldOiAoKSA9PiBVU0RDX09OKENoYWluSWQuUE9MWUdPTl9NVU1CQUkpLFxuICAgIFtDaGFpbklkLkNFTE9dOiAoKSA9PiBDVVNEX0NFTE8sXG4gICAgW0NoYWluSWQuQ0VMT19BTEZBSk9SRVNdOiAoKSA9PiBDVVNEX0NFTE9fQUxGQUpPUkVTLFxuICAgIFtDaGFpbklkLk1PT05CRUFNXTogKCkgPT4gbnVsbCxcbiAgICBbQ2hhaW5JZC5HTk9TSVNdOiAoKSA9PiBudWxsLFxuICAgIFtDaGFpbklkLkFSQklUUlVNX0dPRVJMSV06ICgpID0+IG51bGwsXG4gICAgW0NoYWluSWQuQk5CXTogKCkgPT4gVVNEQ19PTihDaGFpbklkLkJOQiksXG4gICAgW0NoYWluSWQuQk5CX1RFU1RORVRdOiAoKSA9PiBudWxsLFxuICAgIFtDaGFpbklkLkFWQUxBTkNIRV06ICgpID0+IFVTRENfT04oQ2hhaW5JZC5BVkFMQU5DSEUpLFxuICAgIFtDaGFpbklkLkJBU0VfR09FUkxJXTogKCkgPT4gVVNEQ19PTihDaGFpbklkLkJBU0VfR09FUkxJKSxcbiAgICBbQ2hhaW5JZC5CQVNFXTogKCkgPT4gVVNEQ19PTihDaGFpbklkLkJBU0UpLFxuICB9XG5cbiAgY29uc3QgVEVTVF9FUkMyMF8yOiB7IFtjaGFpbklkIGluIENoYWluSWRdOiAoKSA9PiBUb2tlbiB8IG51bGwgfSA9IHtcbiAgICBbQ2hhaW5JZC5NQUlOTkVUXTogKCkgPT4gREFJX09OKDEpLFxuICAgIFtDaGFpbklkLkdPRVJMSV06ICgpID0+IERBSV9PTihDaGFpbklkLkdPRVJMSSksXG4gICAgW0NoYWluSWQuU0VQT0xJQV06ICgpID0+IERBSV9PTihDaGFpbklkLlNFUE9MSUEpLFxuICAgIFtDaGFpbklkLk9QVElNSVNNXTogKCkgPT4gREFJX09OKENoYWluSWQuT1BUSU1JU00pLFxuICAgIFtDaGFpbklkLk9QVElNSVNNX0dPRVJMSV06ICgpID0+IERBSV9PTihDaGFpbklkLk9QVElNSVNNX0dPRVJMSSksXG4gICAgW0NoYWluSWQuQVJCSVRSVU1fT05FXTogKCkgPT4gREFJX09OKENoYWluSWQuQVJCSVRSVU1fT05FKSxcbiAgICBbQ2hhaW5JZC5QT0xZR09OXTogKCkgPT4gREFJX09OKENoYWluSWQuUE9MWUdPTiksXG4gICAgW0NoYWluSWQuUE9MWUdPTl9NVU1CQUldOiAoKSA9PiBEQUlfT04oQ2hhaW5JZC5QT0xZR09OX01VTUJBSSksXG4gICAgW0NoYWluSWQuQ0VMT106ICgpID0+IENFVVJfQ0VMTyxcbiAgICBbQ2hhaW5JZC5DRUxPX0FMRkFKT1JFU106ICgpID0+IENFVVJfQ0VMT19BTEZBSk9SRVMsXG4gICAgW0NoYWluSWQuTU9PTkJFQU1dOiAoKSA9PiBudWxsLFxuICAgIFtDaGFpbklkLkdOT1NJU106ICgpID0+IG51bGwsXG4gICAgW0NoYWluSWQuQVJCSVRSVU1fR09FUkxJXTogKCkgPT4gbnVsbCxcbiAgICBbQ2hhaW5JZC5CTkJdOiAoKSA9PiBVU0RUX09OKENoYWluSWQuQk5CKSxcbiAgICBbQ2hhaW5JZC5CTkJfVEVTVE5FVF06ICgpID0+IG51bGwsXG4gICAgW0NoYWluSWQuQVZBTEFOQ0hFXTogKCkgPT4gREFJX09OKENoYWluSWQuQVZBTEFOQ0hFKSxcbiAgICBbQ2hhaW5JZC5CQVNFX0dPRVJMSV06ICgpID0+IFdOQVRJVkVfT04oQ2hhaW5JZC5CQVNFX0dPRVJMSSksXG4gICAgW0NoYWluSWQuQkFTRV06ICgpID0+IFdOQVRJVkVfT04oQ2hhaW5JZC5CQVNFKSxcbiAgfVxuXG4gIC8vIFRPRE86IEZpbmQgdmFsaWQgcG9vbHMvdG9rZW5zIG9uIG9wdGltaXN0aWMga292YW4gYW5kIHBvbHlnb24gbXVtYmFpLiBXZSBza2lwIHRob3NlIHRlc3RzIGZvciBub3cuXG4gIGZvciAoY29uc3QgY2hhaW4gb2YgXy5maWx0ZXIoXG4gICAgU1VQUE9SVEVEX0NIQUlOUyxcbiAgICAoYykgPT5cbiAgICAgIGMgIT0gQ2hhaW5JZC5QT0xZR09OX01VTUJBSSAmJlxuICAgICAgYyAhPSBDaGFpbklkLkFSQklUUlVNX0dPRVJMSSAmJlxuICAgICAgYyAhPSBDaGFpbklkLkNFTE9fQUxGQUpPUkVTICYmXG4gICAgICBjICE9IENoYWluSWQuR09FUkxJICYmXG4gICAgICBjICE9IENoYWluSWQuU0VQT0xJQVxuICApKSB7XG4gICAgZm9yIChjb25zdCB0eXBlIG9mIFsnZXhhY3RJbicsICdleGFjdE91dCddKSB7XG4gICAgICBjb25zdCBlcmMxID0gVEVTVF9FUkMyMF8xW2NoYWluXSgpXG4gICAgICBjb25zdCBlcmMyID0gVEVTVF9FUkMyMF8yW2NoYWluXSgpXG5cbiAgICAgIC8vIFRoaXMgaXMgZm9yIEdub3NpcyBhbmQgTW9vbmJlYW0gd2hpY2ggd2UgZG9uJ3QgaGF2ZSBSUEMgUHJvdmlkZXJzIHlldFxuICAgICAgaWYgKGVyYzEgPT0gbnVsbCB8fCBlcmMyID09IG51bGwpIGNvbnRpbnVlXG5cbiAgICAgIGRlc2NyaWJlKGAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbil9ICR7dHlwZX0gMnh4YCwgZnVuY3Rpb24gKCkge1xuICAgICAgICAvLyBIZWxwIHdpdGggdGVzdCBmbGFraW5lc3MgYnkgcmV0cnlpbmcuXG4gICAgICAgIHRoaXMucmV0cmllcygwKVxuICAgICAgICBjb25zdCB3cmFwcGVkTmF0aXZlID0gV05BVElWRV9PTihjaGFpbilcblxuICAgICAgICBpdChgJHt3cmFwcGVkTmF0aXZlLnN5bWJvbH0gLT4gZXJjMjBgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICB0b2tlbkluQWRkcmVzczogd3JhcHBlZE5hdGl2ZS5hZGRyZXNzLFxuICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IGNoYWluLFxuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiBlcmMxLmFkZHJlc3MsXG4gICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IGNoYWluLFxuICAgICAgICAgICAgYW1vdW50OiBhd2FpdCBnZXRBbW91bnRGcm9tVG9rZW4odHlwZSwgd3JhcHBlZE5hdGl2ZSwgZXJjMSwgJzEnKSxcbiAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXI6IHRydWUsXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2U6IEF4aW9zUmVzcG9uc2U8UXVvdGVSZXNwb25zZT4gPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgICAgICAgICBjb25zdCB7IHN0YXR1cyB9ID0gcmVzcG9uc2VcblxuICAgICAgICAgICAgZXhwZWN0KHN0YXR1cykudG8uZXF1YWwoMjAwKVxuICAgICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XG4gICAgICAgICAgICBmYWlsKEpTT04uc3RyaW5naWZ5KGVyci5yZXNwb25zZS5kYXRhKSlcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG5cbiAgICAgICAgaXQoYGVyYzIwIC0+IGVyYzIwYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHF1b3RlUmVxOiBRdW90ZVF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICAgICAgdG9rZW5JbkFkZHJlc3M6IGVyYzEuYWRkcmVzcyxcbiAgICAgICAgICAgIHRva2VuSW5DaGFpbklkOiBjaGFpbixcbiAgICAgICAgICAgIHRva2VuT3V0QWRkcmVzczogZXJjMi5hZGRyZXNzLFxuICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiBjaGFpbixcbiAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50RnJvbVRva2VuKHR5cGUsIGVyYzEsIGVyYzIsICcxJyksXG4gICAgICAgICAgICB0eXBlLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlOiBBeGlvc1Jlc3BvbnNlPFF1b3RlUmVzcG9uc2U+ID0gYXdhaXQgYXhpb3MuZ2V0PFF1b3RlUmVzcG9uc2U+KGAke0FQSX0/JHtxdWVyeVBhcmFtc31gKVxuICAgICAgICAgICAgY29uc3QgeyBzdGF0dXMgfSA9IHJlc3BvbnNlXG5cbiAgICAgICAgICAgIGV4cGVjdChzdGF0dXMpLnRvLmVxdWFsKDIwMClcbiAgICAgICAgICB9IGNhdGNoIChlcnI6IGFueSkge1xuICAgICAgICAgICAgZmFpbChKU09OLnN0cmluZ2lmeShlcnIucmVzcG9uc2UuZGF0YSkpXG4gICAgICAgICAgfVxuICAgICAgICB9KVxuICAgICAgICBjb25zdCBuYXRpdmUgPSBOQVRJVkVfQ1VSUkVOQ1lbY2hhaW5dXG4gICAgICAgIGl0KGAke25hdGl2ZX0gLT4gZXJjMjBgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgLy8gVE9ETyBST1VURS02NDogUmVtb3ZlIHRoaXMgb25jZSBzbWFydC1vcmRlci1yb3V0ZXIgc3VwcG9ydHMgRVRIIG5hdGl2ZSBjdXJyZW5jeSBvbiBCQVNFXG4gICAgICAgICAgLy8gc2VlIGh0dHBzOi8vdW5pc3dhcHRlYW0uc2xhY2suY29tL2FyY2hpdmVzL0MwMjFTVTRQTVI3L3AxNjkxNTkzNjc5MTA4NDU5P3RocmVhZF90cz0xNjkxNTMyMzM2Ljc0MjQxOSZjaWQ9QzAyMVNVNFBNUjdcbiAgICAgICAgICBjb25zdCBiYXNlRXJjMjAgPSBjaGFpbiA9PSBDaGFpbklkLkJBU0UgPyBVU0RDX09OKENoYWluSWQuQkFTRSkgOiBlcmMyXG5cbiAgICAgICAgICBjb25zdCBxdW90ZVJlcTogUXVvdGVRdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgICAgIHRva2VuSW5BZGRyZXNzOiBuYXRpdmUsXG4gICAgICAgICAgICB0b2tlbkluQ2hhaW5JZDogY2hhaW4sXG4gICAgICAgICAgICB0b2tlbk91dEFkZHJlc3M6IGJhc2VFcmMyMC5hZGRyZXNzLFxuICAgICAgICAgICAgdG9rZW5PdXRDaGFpbklkOiBjaGFpbixcbiAgICAgICAgICAgIGFtb3VudDogYXdhaXQgZ2V0QW1vdW50RnJvbVRva2VuKHR5cGUsIFdOQVRJVkVfT04oY2hhaW4pLCBiYXNlRXJjMjAsICcxJyksXG4gICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyOiB0cnVlLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcXMuc3RyaW5naWZ5KHF1b3RlUmVxKVxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZXNwb25zZTogQXhpb3NSZXNwb25zZTxRdW90ZVJlc3BvbnNlPiA9IGF3YWl0IGF4aW9zLmdldDxRdW90ZVJlc3BvbnNlPihgJHtBUEl9PyR7cXVlcnlQYXJhbXN9YClcbiAgICAgICAgICAgIGNvbnN0IHsgc3RhdHVzIH0gPSByZXNwb25zZVxuXG4gICAgICAgICAgICBleHBlY3Qoc3RhdHVzKS50by5lcXVhbCgyMDAsIEpTT04uc3RyaW5naWZ5KHJlc3BvbnNlLmRhdGEpKVxuICAgICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XG4gICAgICAgICAgICBmYWlsKEpTT04uc3RyaW5naWZ5KGVyci5yZXNwb25zZS5kYXRhKSlcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgICAgIGl0KGBoYXMgcXVvdGVHYXNBZGp1c3RlZCB2YWx1ZXNgLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcXVvdGVSZXE6IFF1b3RlUXVlcnlQYXJhbXMgPSB7XG4gICAgICAgICAgICB0b2tlbkluQWRkcmVzczogZXJjMS5hZGRyZXNzLFxuICAgICAgICAgICAgdG9rZW5JbkNoYWluSWQ6IGNoYWluLFxuICAgICAgICAgICAgdG9rZW5PdXRBZGRyZXNzOiBlcmMyLmFkZHJlc3MsXG4gICAgICAgICAgICB0b2tlbk91dENoYWluSWQ6IGNoYWluLFxuICAgICAgICAgICAgYW1vdW50OiBhd2FpdCBnZXRBbW91bnRGcm9tVG9rZW4odHlwZSwgZXJjMSwgZXJjMiwgJzEnKSxcbiAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgcXVlcnlQYXJhbXMgPSBxcy5zdHJpbmdpZnkocXVvdGVSZXEpXG5cbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2U6IEF4aW9zUmVzcG9uc2U8UXVvdGVSZXNwb25zZT4gPSBhd2FpdCBheGlvcy5nZXQ8UXVvdGVSZXNwb25zZT4oYCR7QVBJfT8ke3F1ZXJ5UGFyYW1zfWApXG4gICAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICAgIGRhdGE6IHsgcXVvdGVEZWNpbWFscywgcXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzIH0sXG4gICAgICAgICAgICAgIHN0YXR1cyxcbiAgICAgICAgICAgIH0gPSByZXNwb25zZVxuXG4gICAgICAgICAgICBleHBlY3Qoc3RhdHVzKS50by5lcXVhbCgyMDApXG5cbiAgICAgICAgICAgIC8vIGNoZWNrIGZvciBxdW90ZXMgdG8gYmUgZ2FzIGFkanVzdGVkXG4gICAgICAgICAgICBpZiAodHlwZSA9PSAnZXhhY3RJbicpIHtcbiAgICAgICAgICAgICAgZXhwZWN0KHBhcnNlRmxvYXQocXVvdGVHYXNBZGp1c3RlZERlY2ltYWxzKSkudG8uYmUubGVzc1RoYW5PckVxdWFsKHBhcnNlRmxvYXQocXVvdGVEZWNpbWFscykpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBleHBlY3QocGFyc2VGbG9hdChxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHMpKS50by5iZS5ncmVhdGVyVGhhbk9yRXF1YWwocGFyc2VGbG9hdChxdW90ZURlY2ltYWxzKSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIChlcnI6IGFueSkge1xuICAgICAgICAgICAgZmFpbChKU09OLnN0cmluZ2lmeShlcnIucmVzcG9uc2UuZGF0YSkpXG4gICAgICAgICAgfVxuICAgICAgICB9KVxuICAgICAgfSlcbiAgICB9XG4gIH1cbn0pXG5cbmRlc2NyaWJlKCdhbHBoYSBvbmx5IHF1b3RlJywgZnVuY3Rpb24gKCkge1xuICB0aGlzLnRpbWVvdXQoNTAwMClcblxuICBmb3IgKGNvbnN0IHR5cGUgb2YgWydleGFjdEluJywgJ2V4YWN0T3V0J10pIHtcbiAgICBkZXNjcmliZShgJHt0eXBlfSAyeHhgLCAoKSA9PiB7fSlcbiAgfVxufSlcbiJdfQ==
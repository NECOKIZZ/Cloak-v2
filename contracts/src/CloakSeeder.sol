// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakPair} from "./CloakPair.sol";
import {IMarketSeeder} from "./CloakAuction.sol";
import {CloakV2Market, mulDiv} from "./CloakV2Market.sol";
import {IUniswapV2Factory, IUniswapV2Pair, IWETH} from "./uniswap/IUniswapV2.sol";

interface IERC20Seed {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

/// @title CloakSeeder — opens a settled launch's market at exactly the clearing price.
/// @notice With a Uniswap V2 factory set, the market is a standard Uniswap V2 pool (token / WHYPE) wrapped in a
///         CloakV2Market, so the token is tradable and trackable everywhere. Without one, or if the Uniswap pool can't be
///         opened at the clearing price, the market is a CloakPair as before. Either way the LP goes to `lpTo` (the
///         auction, to lock, or 0x…dEaD, to burn), and whatever isn't used goes back to the caller.
///
///         Opening at the right price: the pool's address is known before it exists, so anyone can send tokens or
///         WHYPE to it, or create it and `sync`, before settlement. Stray balances are skimmed to 0x…dEaD; synced
///         reserves are topped up so the pool still opens at the clearing price (whoever donated loses it). A pool that
///         already has LP (someone minted first, which needs launch tokens before settlement) is left alone and the
///         launch gets a CloakPair, so nobody else's position can set the price.
/// @dev Holds nothing between calls. The Uniswap attempt runs in a self-call with a fixed gas budget, so a failure
///      there rolls back cleanly; a caller can't force the fallback by sending too little gas.
contract CloakSeeder is IMarketSeeder {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @notice Gas reserved for the Uniswap attempt (creating the pool and the adapter, then minting).
    uint256 public constant V2_GAS = 6_000_000;

    IUniswapV2Factory public immutable uniFactory; // 0 = no Uniswap on this chain: always a CloakPair
    IWETH public immutable weth; // the market's wrapped HYPE (what the Uniswap pools pair with)
    uint256 public immutable feeNum; // the pools' input fee out of 1000 (997 for Uniswap V2)

    event Seeded(address indexed token, address market, address uniPair, uint256 hype, uint256 tokens, uint256 shares);

    constructor(IUniswapV2Factory uniFactory_, IWETH weth_, uint256 feeNum_) {
        require(address(uniFactory_) == address(0) || address(weth_) != address(0), "weth");
        uniFactory = uniFactory_;
        weth = weth_;
        feeNum = feeNum_;
    }

    receive() external payable {
        require(msg.sender == address(weth), "direct HYPE");
    }

    /// @notice Open the market for `token` at `price` (wei of HYPE per 1e18 tokens) with up to msg.value HYPE and up to
    ///         `tokenAmount` tokens (pulled from the caller, which must have approved this contract).
    function seed(address token, uint256 tokenAmount, uint256 price, address lpTo)
        external
        payable
        returns (address market, address uniPair, uint256 shares, uint256 hypeUsed, uint256 tokensUsed)
    {
        require(msg.value > 0 && tokenAmount > 0 && price > 0, "zero");
        require(IERC20Seed(token).transferFrom(msg.sender, address(this), tokenAmount), "tf");

        bool done;
        if (address(uniFactory) != address(0)) {
            // enough gas for the attempt and the fallback after it, so "out of gas" is never the caller's choice
            require(gasleft() > V2_GAS + 1_000_000, "gas");
            try this.seedV2{value: msg.value, gas: V2_GAS}(token, tokenAmount, price, lpTo) returns (
                address m, address u, uint256 s, uint256 h, uint256 t
            ) {
                (market, uniPair, shares, hypeUsed, tokensUsed) = (m, u, s, h, t);
                done = true;
            } catch {}
        }
        if (!done) {
            CloakPair p = new CloakPair(token);
            require(IERC20Seed(token).approve(address(p), tokenAmount), "approve");
            shares = p.addLiquidity{value: msg.value}(tokenAmount, 0, lpTo);
            (market, hypeUsed, tokensUsed) = (address(p), msg.value, tokenAmount);
        }

        if (tokenAmount > tokensUsed) require(IERC20Seed(token).transfer(msg.sender, tokenAmount - tokensUsed), "t");
        if (msg.value > hypeUsed) {
            (bool ok,) = msg.sender.call{value: msg.value - hypeUsed}("");
            require(ok, "refund");
        }
        emit Seeded(token, market, uniPair, hypeUsed, tokensUsed, shares);
    }

    /// @dev The Uniswap attempt. Only this contract may call it (from `seed`); any revert rolls back all of it.
    function seedV2(address token, uint256 maxTokens, uint256 price, address lpTo)
        external
        payable
        returns (address market, address uniPair, uint256 shares, uint256 hypeUsed, uint256 tokensUsed)
    {
        require(msg.sender == address(this), "self");
        uniPair = uniFactory.getPair(token, address(weth));
        if (uniPair == address(0)) uniPair = uniFactory.createPair(token, address(weth));
        IUniswapV2Pair p = IUniswapV2Pair(uniPair);
        require(p.totalSupply() == 0, "pool has LP");
        p.skim(DEAD); // balances sent to the pool's address before it had reserves

        (uint112 r0, uint112 r1,) = p.getReserves();
        bool tokenIs0 = p.token0() == token;
        (uint256 rH, uint256 rT) = tokenIs0 ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));

        // amounts so that (rH + hype) / (rT + tokens) = price: every token first, else every HYPE
        tokensUsed = maxTokens;
        uint256 needH = mulDiv(price, rT + tokensUsed, 1e18);
        require(needH > rH, "price");
        hypeUsed = needH - rH;
        if (hypeUsed > msg.value) {
            hypeUsed = msg.value;
            uint256 t = mulDiv(rH + hypeUsed, 1e18, price);
            require(t > rT, "price");
            tokensUsed = t - rT;
        }
        require(hypeUsed > 0 && tokensUsed > 0, "zero");

        weth.deposit{value: hypeUsed}();
        require(weth.transfer(uniPair, hypeUsed), "weth");
        require(IERC20Seed(token).transfer(uniPair, tokensUsed), "t");
        shares = p.mint(lpTo);
        market = address(new CloakV2Market(p, token, weth, feeNum));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Min {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice Minimal constant-product AMM between native HYPE and one ERC20, 0.3% fee.
/// Cloak ships its own pair so a launch never depends on which DEX happens to be deployed on the testnet.
/// @dev Keeps a cumulative price (HYPE per 1e18 tokens, × seconds), like Uniswap v2, so other contracts can read a
///      time-weighted average that one transaction cannot move.
contract CloakPair {
    uint256 public constant MIN_LIQUIDITY = 1000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable token;
    uint256 public reserveHype;
    uint256 public reserveToken;

    uint256 public priceCumulative; // Σ spot price × seconds it held
    uint64 public lastUpdate;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    uint256 private _lock = 1;

    event Mint(address indexed to, uint256 hype, uint256 tokens, uint256 shares);
    event Burn(address indexed to, uint256 hype, uint256 tokens, uint256 shares);
    event Swap(address indexed trader, bool hypeIn, uint256 amountIn, uint256 amountOut, address indexed to);
    event ShareTransfer(address indexed from, address indexed to, uint256 shares);

    modifier lock() {
        require(_lock == 1, "locked");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address token_) {
        token = token_;
    }

    /// @notice Spot price: wei of HYPE per 1e18 token units.
    function price() external view returns (uint256) {
        return reserveToken == 0 ? 0 : (reserveHype * 1e18) / reserveToken;
    }

    /// @notice priceCumulative as of now (including the time since the last trade).
    function cumulativeNow() public view returns (uint256 cum, uint64 at) {
        cum = priceCumulative;
        at = uint64(block.timestamp);
        if (reserveToken != 0 && at > lastUpdate) {
            unchecked {
                cum += ((reserveHype * 1e18) / reserveToken) * (at - lastUpdate);
            }
        }
    }

    function _accrue() internal {
        (priceCumulative, lastUpdate) = cumulativeNow();
    }

    function getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) public pure returns (uint256) {
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    function addLiquidity(uint256 tokenAmount, uint256 minShares, address to)
        external
        payable
        lock
        returns (uint256 shares)
    {
        _accrue();
        require(msg.value > 0 && tokenAmount > 0, "zero");
        require(IERC20Min(token).transferFrom(msg.sender, address(this), tokenAmount), "tf");
        if (totalShares == 0) {
            shares = _sqrt(msg.value * tokenAmount) - MIN_LIQUIDITY;
            _mintShares(DEAD, MIN_LIQUIDITY);
        } else {
            uint256 a = (msg.value * totalShares) / reserveHype;
            uint256 b = (tokenAmount * totalShares) / reserveToken;
            shares = a < b ? a : b;
        }
        require(shares > 0 && shares >= minShares, "shares");
        reserveHype += msg.value;
        reserveToken += tokenAmount;
        _mintShares(to, shares);
        emit Mint(to, msg.value, tokenAmount, shares);
    }

    function removeLiquidity(uint256 shares, address to) external lock returns (uint256 hype, uint256 tokens) {
        _accrue();
        require(sharesOf[msg.sender] >= shares && shares > 0, "shares");
        hype = (shares * reserveHype) / totalShares;
        tokens = (shares * reserveToken) / totalShares;
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        reserveHype -= hype;
        reserveToken -= tokens;
        require(IERC20Min(token).transfer(to, tokens), "t");
        _sendHype(to, hype);
        emit Burn(to, hype, tokens, shares);
    }

    function swapExactHypeForTokens(uint256 minOut, address to) external payable lock returns (uint256 out) {
        _accrue();
        require(msg.value > 0, "zero");
        out = getAmountOut(msg.value, reserveHype, reserveToken);
        require(out >= minOut && out > 0, "slippage");
        reserveHype += msg.value;
        reserveToken -= out;
        require(IERC20Min(token).transfer(to, out), "t");
        emit Swap(msg.sender, true, msg.value, out, to);
    }

    function swapExactTokensForHype(uint256 amountIn, uint256 minOut, address to) external lock returns (uint256 out) {
        _accrue();
        require(amountIn > 0, "zero");
        require(IERC20Min(token).transferFrom(msg.sender, address(this), amountIn), "tf");
        out = getAmountOut(amountIn, reserveToken, reserveHype);
        require(out >= minOut && out > 0, "slippage");
        reserveToken += amountIn;
        reserveHype -= out;
        _sendHype(to, out);
        emit Swap(msg.sender, false, amountIn, out, to);
    }

    function transferShares(address to, uint256 shares) external {
        require(sharesOf[msg.sender] >= shares, "shares");
        sharesOf[msg.sender] -= shares;
        sharesOf[to] += shares;
        emit ShareTransfer(msg.sender, to, shares);
    }

    function _mintShares(address to, uint256 shares) internal {
        totalShares += shares;
        sharesOf[to] += shares;
        emit ShareTransfer(address(0), to, shares);
    }

    function _sendHype(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send");
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}

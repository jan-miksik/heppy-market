// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IIUSDDemoMintable {
    function mint(address to, uint256 amount) external;
}

/// @title iUSD-demo faucet
/// @notice Unlimited test-only faucet that mints iUSD-demo tokens on demand.
/// @dev DEMO ONLY — DO NOT DEPLOY AGAINST A PRODUCTION TOKEN. Any caller can mint
///      any amount to any address with no cap. Intended exclusively for testnet use
///      with iUSD-demo. Misassigning the minter role on a production token to this
///      contract gives any user unlimited mint authority.
contract IUSDDemoFaucet {
    address public immutable token;

    event FaucetMint(address indexed caller, address indexed receiver, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();

    constructor(address token_) {
        if (token_ == address(0)) revert ZeroAddress();
        token = token_;
    }

    function mint(uint256 amount) external returns (uint256 mintedAmount) {
        mintedAmount = _mintTo(msg.sender, amount);
    }

    function mintTo(address receiver, uint256 amount) external returns (uint256 mintedAmount) {
        mintedAmount = _mintTo(receiver, amount);
    }

    function _mintTo(address receiver, uint256 amount) private returns (uint256 mintedAmount) {
        if (receiver == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        IIUSDDemoMintable(token).mint(receiver, amount);
        emit FaucetMint(msg.sender, receiver, amount);
        return amount;
    }
}

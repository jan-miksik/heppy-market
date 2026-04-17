// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Script.sol";
import {ScriptBase} from "./ScriptBase.sol";
import {MockPerpDEX} from "../src/MockPerpDEX.sol";
import {IUSDDemoToken} from "../src/IUSDDemoToken.sol";
import {IUSDDemoFaucet} from "../src/IUSDDemoFaucet.sol";

/// @notice Deploys MockPerpDEX alongside the iUSD-demo token + faucet.
///         The MockPerpDEX uses iUSD-demo as collateral.
contract DeployMockPerpDEX is ScriptBase {
    function run() external returns (address perpDexAddress) {
        _startBroadcast();

        // Check if iUSD-demo token is already deployed
        address tokenAddress = vm.envOr("IUSD_TOKEN_ADDRESS", address(0));
        if (tokenAddress == address(0)) {
            IUSDDemoToken token = new IUSDDemoToken();
            IUSDDemoFaucet faucet = new IUSDDemoFaucet(address(token));
            token.setMinter(address(faucet), true);
            tokenAddress = address(token);
            console.log("iUSD-demo token deployed at:", tokenAddress);
            console.log("iUSD-demo faucet deployed at:", address(faucet));
        } else {
            console.log("Using existing iUSD-demo token at:", tokenAddress);
        }

        MockPerpDEX perpDex = new MockPerpDEX(tokenAddress);
        perpDexAddress = address(perpDex);

        // Set initial BTC price ($65,000)
        bytes32 btcMarket = keccak256("BTC/USD");
        perpDex.updatePrice(btcMarket, 65_000e18);

        // Set initial ETH price ($3,500)
        bytes32 ethMarket = keccak256("ETH/USD");
        perpDex.updatePrice(ethMarket, 3_500e18);

        vm.stopBroadcast();

        console.log("MockPerpDEX deployed at:", perpDexAddress);
        console.log(string.concat("NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS=", vm.toString(perpDexAddress)));
    }
}

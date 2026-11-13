// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TreasuryFactory} from "../src/TreasuryFactory.sol";

/// Run via scripts/forge-env.py so .env.local is loaded without a shell `source`:
/// python3 ../scripts/forge-env.py script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
contract Deploy is Script {
    function run() external returns (TreasuryFactory factory) {
        address usdc = vm.envAddress("USDC_ADDRESS"); // Arc USDC ERC-20 interface, 0x3600…0000
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        factory = new TreasuryFactory(IERC20(usdc));
        vm.stopBroadcast();
        console2.log("TreasuryFactory:", address(factory));
    }
}

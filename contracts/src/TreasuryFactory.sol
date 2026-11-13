// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CompanyTreasury} from "./CompanyTreasury.sol";

/// @title TreasuryFactory
/// @notice One call creates a company's treasury. Ownerless: the deployer has no special powers.
contract TreasuryFactory {
    IERC20 public immutable usdc;
    address[] private allTreasuries;
    mapping(address => address[]) private treasuriesOf; // approver => treasuries they cosign for

    event TreasuryCreated(
        address indexed treasury, address indexed creator, string name, address[] approvers, uint8 threshold
    );

    constructor(IERC20 _usdc) {
        usdc = _usdc;
    }

    function createTreasury(
        string calldata name,
        address[] calldata approvers,
        address[] calldata proposers,
        uint8 threshold
    ) external returns (address treasury) {
        treasury = address(new CompanyTreasury(name, usdc, approvers, proposers, threshold));
        allTreasuries.push(treasury);
        for (uint256 i; i < approvers.length; ++i) {
            treasuriesOf[approvers[i]].push(treasury);
        }
        emit TreasuryCreated(treasury, msg.sender, name, approvers, threshold);
    }

    function treasuryCount() external view returns (uint256) {
        return allTreasuries.length;
    }

    function treasuryAt(uint256 i) external view returns (address) {
        return allTreasuries[i];
    }

    function treasuriesFor(address approver) external view returns (address[] memory) {
        return treasuriesOf[approver];
    }
}

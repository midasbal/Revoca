// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {CompliancePolicy} from "../src/CompliancePolicy.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {RevocationGuardian} from "../src/RevocationGuardian.sol";
import {GraceAndNotifyStrategy} from "../src/strategies/GraceAndNotifyStrategy.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";
import {ITierOracle} from "../src/interfaces/ITierOracle.sol";
import {ICountrySource} from "../src/interfaces/ICountrySource.sol";
import {TestComplianceGate} from "../src/test/TestComplianceGate.sol";
import {TestTierOracle} from "../src/test/TestTierOracle.sol";
import {TestCountrySource} from "../src/test/TestCountrySource.sol";
import {MockERC20} from "../src/test/MockERC20.sol";
import {EIP712TestUtils} from "./helpers/EIP712TestUtils.sol";

contract CompliancePolicyTest is Test {
    CompliancePolicy policy;

    address owner = address(this);
    address alice = address(0xA11CE);

    uint256 constant GRACE_DURATION = 3600;
    uint256 constant MAX_STALENESS = 1800;

    function setUp() public {
        policy = new CompliancePolicy(owner, GRACE_DURATION, MAX_STALENESS);
    }

    // -------------------------------------------------------------------
    // Setters: every one emits its specific event with correct old/new
    // values, and only the owner can call it.
    // -------------------------------------------------------------------

    function test_SetMinTier_EmitsEventAndOnlyOwner() public {
        vm.expectEmit(false, false, false, true);
        emit CompliancePolicy.MinTierChanged(0, 20);
        policy.setMinTier(20);
        assertEq(policy.minTier(), 20);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setMinTier(50);
    }

    function test_SetMinSubTier_EmitsEventAndOnlyOwner() public {
        vm.expectEmit(false, false, false, true);
        emit CompliancePolicy.MinSubTierChanged(0, 80);
        policy.setMinSubTier(80);
        assertEq(policy.minSubTier(), 80);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setMinSubTier(1);
    }

    function test_SetAllowedGroup_EmitsEventAndOnlyOwner() public {
        vm.expectEmit(false, false, false, true);
        emit CompliancePolicy.AllowedGroupChanged(bytes2(0), bytes2("CC"));
        policy.setAllowedGroup(bytes2("CC"));
        assertEq(policy.allowedGroup(), bytes2("CC"));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setAllowedGroup(bytes2("XX"));
    }

    function test_SetAllowedSubGroup_EmitsEventAndOnlyOwner() public {
        vm.expectEmit(false, false, false, true);
        emit CompliancePolicy.AllowedSubGroupChanged(bytes2(0), bytes2("A"));
        policy.setAllowedSubGroup(bytes2("A"));
        assertEq(policy.allowedSubGroup(), bytes2("A"));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setAllowedSubGroup(bytes2("B"));
    }

    function test_SetCountryRule_EmitsEventAndOnlyOwner() public {
        bytes2[] memory countries = new bytes2[](2);
        countries[0] = bytes2("US");
        countries[1] = bytes2("DE");

        vm.expectEmit(false, false, false, true);
        emit CompliancePolicy.CountryRuleChanged(countries, true);
        policy.setCountryRule(countries, true);

        assertTrue(policy.isBlacklist());
        assertEq(policy.countryList().length, 2);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setCountryRule(countries, false);
    }

    function test_SetRatioBands_EmitsEventAndOnlyOwner() public {
        CompliancePolicy.RatioBand[] memory bands = new CompliancePolicy.RatioBand[](1);
        bands[0] = CompliancePolicy.RatioBand({minTier: 0, minSubTier: 0, ratioBps: 12_000});

        vm.expectEmit(false, false, false, true);
        emit CompliancePolicy.RatioBandsChanged(bands);
        policy.setRatioBands(bands);

        assertEq(policy.ratioBandCount(), 1);
        assertEq(policy.collateralRatioBps(0, 0), 12_000);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setRatioBands(bands);
    }

    function test_SetGraceDuration_EmitsEventAndOnlyOwner() public {
        vm.expectEmit(false, false, false, true);
        emit CompliancePolicy.GraceDurationChanged(GRACE_DURATION, 7200);
        policy.setGraceDuration(7200);
        assertEq(policy.graceDuration(), 7200);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setGraceDuration(1);
    }

    function test_SetMaxComplianceStaleness_EmitsEventAndOnlyOwner() public {
        vm.expectEmit(false, false, false, true);
        emit CompliancePolicy.StalenessChanged(MAX_STALENESS, 3600);
        policy.setMaxComplianceStaleness(3600);
        assertEq(policy.maxComplianceStaleness(), 3600);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setMaxComplianceStaleness(1);
    }

    function test_SetDefaultBorrowCap_EmitsEventAndOnlyOwner() public {
        vm.expectEmit(false, false, false, true);
        emit CompliancePolicy.DefaultBorrowCapChanged(type(uint256).max, 1000e18);
        policy.setDefaultBorrowCap(1000e18);
        assertEq(policy.defaultBorrowCap(), 1000e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setDefaultBorrowCap(1);
    }

    function test_SetTierBorrowCap_EmitsEventAndOnlyOwner() public {
        vm.expectEmit(true, false, false, true);
        emit CompliancePolicy.TierBorrowCapChanged(50, type(uint256).max, 500e18);
        policy.setTierBorrowCap(50, 500e18);
        assertEq(policy.tierBorrowCap(50), 500e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setTierBorrowCap(50, 1);
    }

    function test_SetMaxTotalBorrow_EmitsEventAndOnlyOwner() public {
        vm.expectEmit(false, false, false, true);
        emit CompliancePolicy.MaxTotalBorrowChanged(type(uint256).max, 100_000e18);
        policy.setMaxTotalBorrow(100_000e18);
        assertEq(policy.maxTotalBorrow(), 100_000e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setMaxTotalBorrow(1);
    }

    // -------------------------------------------------------------------
    // getPolicy(), full snapshot in one call
    // -------------------------------------------------------------------

    function test_GetPolicy_ReturnsStructMatchingConfiguredValues() public {
        policy.setMinTier(20);
        policy.setMinSubTier(30);
        policy.setAllowedGroup(bytes2("CC"));
        policy.setAllowedSubGroup(bytes2("A"));

        bytes2[] memory countries = new bytes2[](2);
        countries[0] = bytes2("US");
        countries[1] = bytes2("DE");
        policy.setCountryRule(countries, true);

        policy.setGraceDuration(7200);
        policy.setMaxComplianceStaleness(900);
        policy.setDefaultBorrowCap(1000e18);
        policy.setMaxTotalBorrow(50_000e18);

        CompliancePolicy.Policy memory snapshot = policy.getPolicy();

        assertEq(snapshot.minTier, 20);
        assertEq(snapshot.minSubTier, 30);
        assertEq(snapshot.allowedGroup, bytes2("CC"));
        assertEq(snapshot.allowedSubGroup, bytes2("A"));
        assertTrue(snapshot.isBlacklist);
        assertEq(snapshot.countries.length, 2);
        assertEq(snapshot.countries[0], bytes2("US"));
        assertEq(snapshot.countries[1], bytes2("DE"));
        assertEq(snapshot.ratioBands.length, 6); // default table, untouched in this test
        assertEq(snapshot.graceDuration, 7200);
        assertEq(snapshot.maxComplianceStaleness, 900);
        assertEq(snapshot.defaultBorrowCap, 1000e18);
        assertEq(snapshot.maxTotalBorrow, 50_000e18);
    }

    // -------------------------------------------------------------------
    // isTierEligible, boundary tests
    // -------------------------------------------------------------------

    function test_IsTierEligible_DefaultNoRestriction() public view {
        // minTier/minSubTier default to 0 -> everyone eligible.
        assertTrue(policy.isTierEligible(0, 0));
        assertTrue(policy.isTierEligible(50, 80));
    }

    function test_IsTierEligible_AtExactThreshold() public {
        policy.setMinTier(20);
        policy.setMinSubTier(30);
        assertTrue(policy.isTierEligible(20, 30)); // exactly at threshold
    }

    function test_IsTierEligible_JustBelowSubTierThreshold() public {
        policy.setMinTier(20);
        policy.setMinSubTier(30);
        assertFalse(policy.isTierEligible(20, 29)); // same tier, subTier one below
    }

    function test_IsTierEligible_TierAboveThresholdIgnoresSubTier() public {
        policy.setMinTier(20);
        policy.setMinSubTier(30);
        assertTrue(policy.isTierEligible(21, 0)); // tier exceeds minTier -> subTier irrelevant
    }

    function test_IsTierEligible_TierBelowThreshold() public {
        policy.setMinTier(20);
        policy.setMinSubTier(30);
        assertFalse(policy.isTierEligible(19, 99)); // tier below minTier -> ineligible regardless of subTier
    }

    // -------------------------------------------------------------------
    // isCountryEligible, allowlist / blacklist / empty / multi-country matrix
    // -------------------------------------------------------------------

    function test_IsCountryEligible_EmptyRule_AllPass() public view {
        assertTrue(policy.isCountryEligible(bytes2("US")));
        assertTrue(policy.isCountryEligible(bytes2("DE")));
        assertTrue(policy.isCountryEligible(bytes2(0))); // even unknown/unset
    }

    function test_IsCountryEligible_AllowlistMode_OnlyListedPass() public {
        bytes2[] memory countries = new bytes2[](1);
        countries[0] = bytes2("US");
        policy.setCountryRule(countries, false); // allowlist

        assertTrue(policy.isCountryEligible(bytes2("US")));
        assertFalse(policy.isCountryEligible(bytes2("DE")));
        assertFalse(policy.isCountryEligible(bytes2(0)));
    }

    function test_IsCountryEligible_BlacklistMode_ListedFail() public {
        bytes2[] memory countries = new bytes2[](1);
        countries[0] = bytes2("US");
        policy.setCountryRule(countries, true); // blacklist

        assertFalse(policy.isCountryEligible(bytes2("US")));
        assertTrue(policy.isCountryEligible(bytes2("DE")));
        assertTrue(policy.isCountryEligible(bytes2(0)));
    }

    function test_IsCountryEligible_MultiCountrySet_Allowlist() public {
        bytes2[] memory countries = new bytes2[](3);
        countries[0] = bytes2("US");
        countries[1] = bytes2("DE");
        countries[2] = bytes2("SG");
        policy.setCountryRule(countries, false);

        assertTrue(policy.isCountryEligible(bytes2("US")));
        assertTrue(policy.isCountryEligible(bytes2("DE")));
        assertTrue(policy.isCountryEligible(bytes2("SG")));
        assertFalse(policy.isCountryEligible(bytes2("FR")));
    }

    function test_IsCountryEligible_MultiCountrySet_Blacklist() public {
        bytes2[] memory countries = new bytes2[](3);
        countries[0] = bytes2("US");
        countries[1] = bytes2("DE");
        countries[2] = bytes2("SG");
        policy.setCountryRule(countries, true);

        assertFalse(policy.isCountryEligible(bytes2("US")));
        assertFalse(policy.isCountryEligible(bytes2("DE")));
        assertFalse(policy.isCountryEligible(bytes2("SG")));
        assertTrue(policy.isCountryEligible(bytes2("FR")));
    }

    function test_SetCountryRule_ReplacesEntireSetAtomically() public {
        bytes2[] memory first = new bytes2[](2);
        first[0] = bytes2("US");
        first[1] = bytes2("DE");
        policy.setCountryRule(first, false);
        assertTrue(policy.isCountryEligible(bytes2("US")));

        bytes2[] memory second = new bytes2[](1);
        second[0] = bytes2("FR");
        policy.setCountryRule(second, false);

        // US/DE no longer eligible, the old set was fully replaced, not merged.
        assertFalse(policy.isCountryEligible(bytes2("US")));
        assertFalse(policy.isCountryEligible(bytes2("DE")));
        assertTrue(policy.isCountryEligible(bytes2("FR")));
        assertEq(policy.countryList().length, 1);
    }
}

/**
 * @notice Integration tests: LendingPool.borrow() actually enforces
 * CompliancePolicy's tier and country eligibility rules, a borrower
 * blocked SOLELY by one axis cannot borrow even if the other axis is
 * satisfied, and passing both allows the borrow. Also confirms grace
 * duration and staleness tolerance changes on the policy propagate live to
 * RevocationGuardian and ComplianceRegistry respectively.
 */
contract CompliancePolicyIntegrationTest is EIP712TestUtils {
    LendingPool pool;
    CompliancePolicy policy;
    TestComplianceGate complianceGate;
    TestTierOracle tierOracle;
    TestCountrySource countrySource;
    MockERC20 asset;

    address owner = address(this);
    address lender = address(0x1EA1);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant GRACE_DURATION = 3600;
    uint256 constant MAX_STALENESS = 1800;

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        complianceGate = new TestComplianceGate();
        tierOracle = new TestTierOracle();
        countrySource = new TestCountrySource();
        policy = new CompliancePolicy(owner, GRACE_DURATION, MAX_STALENESS);

        pool = new LendingPool(
            IERC20(address(asset)),
            IComplianceGate(address(complianceGate)),
            ITierOracle(address(tierOracle)),
            ICountrySource(address(countrySource)),
            policy,
            owner,
            1,
            500
        );

        address[3] memory users = [lender, alice, bob];
        for (uint256 i = 0; i < users.length; i++) {
            asset.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            asset.approve(address(pool), type(uint256).max);
        }

        vm.prank(lender);
        pool.deposit(100_000e18);

        // A min-tier floor: tier must be >= 20 to be eligible at all.
        policy.setMinTier(20);

        // A country allowlist: only "US" is eligible.
        bytes2[] memory allowed = new bytes2[](1);
        allowed[0] = bytes2("US");
        policy.setCountryRule(allowed, false);
    }

    function test_Borrow_BlockedSolelyByCountryRule_EvenWithQualifyingTier() public {
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80); // qualifies the min-tier floor comfortably
        countrySource.setCountry(alice, bytes2("FR")); // NOT in the allowlist

        vm.prank(alice);
        pool.postCollateral(1000e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.CountryNotEligible.selector, alice, bytes2("FR")));
        pool.borrow(100e18);
    }

    function test_Borrow_BlockedSolelyByMinTier_EvenFromAllowedCountry() public {
        complianceGate.setCompliant(bob, true);
        tierOracle.setTier(bob, 10, 0); // below the minTier=20 floor
        countrySource.setCountry(bob, bytes2("US")); // in the allowlist

        vm.prank(bob);
        pool.postCollateral(1000e18);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.TierNotEligible.selector, bob, 10, 0));
        pool.borrow(100e18);
    }

    function test_Borrow_SucceedsWhenBothTierAndCountryEligible() public {
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);
        countrySource.setCountry(alice, bytes2("US"));

        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(100e18);

        assertEq(pool.currentDebt(alice), 100e18);
    }

    uint256 constant ATTESTOR_PK = 0xA771E5709;

    function _attest(
        ComplianceRegistry registry,
        address user,
        uint16 tier,
        uint16 subTier,
        uint8 apassStatus
    ) internal {
        ComplianceRegistry.ComplianceAttestation memory a = ComplianceRegistry.ComplianceAttestation({
            user: user,
            tier: tier,
            subTier: subTier,
            country: bytes2("US"),
            apassStatus: apassStatus,
            expiry: block.timestamp + 365 days,
            issuedAt: block.timestamp,
            nonce: registry.lastNonce(user) + 1
        });
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));
    }

    function test_GraceDurationChange_PropagatesLiveToGuardian() public {
        ComplianceRegistry registry = new ComplianceRegistry(owner, policy);
        registry.setAttestor(vm.addr(ATTESTOR_PK), true);

        LendingPool p2 = new LendingPool(
            IERC20(address(asset)),
            IComplianceGate(address(registry)),
            ITierOracle(address(registry)),
            ICountrySource(address(countrySource)),
            policy,
            owner,
            1,
            500
        );
        RevocationGuardian guardian = new RevocationGuardian(registry, p2, owner, new GraceAndNotifyStrategy(p2));
        p2.setGuardian(address(guardian));

        _attest(registry, alice, 50, 80, registry.APASS_STATUS_FROZEN());

        policy.setGraceDuration(9999);
        guardian.flag(alice);

        (,,, uint256 graceEndsAt,) = guardian.positions(alice);
        assertEq(graceEndsAt, block.timestamp + 9999);
    }

    function test_StalenessChange_PropagatesLiveToRegistry() public {
        ComplianceRegistry registry = new ComplianceRegistry(owner, policy);
        registry.setAttestor(vm.addr(ATTESTOR_PK), true);

        _attest(registry, alice, 50, 80, registry.APASS_STATUS_ACTIVE());

        policy.setMaxComplianceStaleness(10);
        vm.warp(block.timestamp + 11);

        assertFalse(registry.isFresh(alice)); // new, tighter staleness window applies immediately
    }
}

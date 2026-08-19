// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/distribution-tx/route`
 * Purpose: Serve the EXECUTE payload for a finalized epoch — everything the node admin's wallet
 *   needs to build ONE Aragon TokenVoting proposal that mints the epoch's delta into the DAO's
 *   cumulative distributor and sets the new merkle root. The finalize fold NEVER sends this tx; this
 *   route only reads what R3 persisted (the manifest header) plus the node's OWN governance addresses
 *   (from repo-spec — single-node, no operator gateway) so the admin's wallet can build + submit the
 *   proposal (which EarlyExecution executes atomically).
 * Scope: Thin authed read shell — SIWE + approver-gated (mirrors the finalize route), read the epoch's
 *   persisted manifest (`getDistributionManifestForEpoch`) + the immediately-prior finalized epoch's
 *   manifest to compute the mint delta, and read the node's DAO/plugin governance addresses from its
 *   OWN repo-spec (`getDaoConfig`). No tx, no business logic, no merkle building.
 * Invariants:
 *   - NODE_SCOPED (single-node): governance addresses come from THIS node's repo-spec, never a nodes-table row.
 *   - ALL_MATH_BIGINT (mintDelta serialized as a decimal string), VALIDATE_IO.
 *   - READ_ONLY_SERVES_R3: returns only persisted manifest + repo-spec governance addresses; never
 *     mutates state and never signs/sends a transaction.
 *   - FINALIZED_AND_RECORDED: gated on epoch finalized + manifest exists + distributorAddress
 *     recorded; otherwise 409 (nothing to execute yet).
 *   - CUMULATIVE_DELTA: mintDelta = thisManifest.distributionAmount − priorManifest.distributionAmount
 *     where prior = most-recent finalized epoch (by id) with a persisted manifest; for the FIRST
 *     distribution (no prior manifest) mintDelta == thisManifest.distributionAmount (cumulativeTotal).
 *   - ALREADY_PUBLISHED_IDEMPOTENT (bug.5022): read the distributor's LIVE merkle root and refuse to
 *     serve a mint payload for a root already on-chain (409 already_published). SERVER-SIDE backstop.
 *   - APPROVER_GATED: node ledger approver (repo-spec) authorizes the read.
 * Side-effects: IO (HTTP response, database read, best-effort viem RPC read of the live merkle root)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.epoch-distribution.v1.contract,
 *   packages/attribution-ledger/src/store.ts (DistributionManifestStore)
 * @public
 */

import { CHAINS } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { type Address, createPublicClient, http } from "viem";
import { base, sepolia } from "viem/chains";
import { getSessionUser } from "@/app/_lib/auth/session";
import { checkApprover } from "@/app/api/v1/attribution/_lib/approver-guard";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getDaoConfig } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "ledger.distribution-tx";

// Map a NODE's chain id to its viem chain object (mirrors setup/verify).
// Chain ids come from the shared CHAINS registry (never hardcode — no-restricted-syntax).
const VIEM_CHAINS_BY_ID: Record<number, typeof base | typeof sepolia> = {
  [CHAINS.BASE.chainId]: base,
  [CHAINS.SEPOLIA.chainId]: sepolia,
};

// Minimal ABI to read the cumulative distributor's live merkle root.
const MERKLE_ROOT_ABI = [
  {
    type: "function",
    name: "merkleRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/**
 * Read the distributor's live on-chain merkle root, or null when it can't be read
 * (unsupported chain, no RPC, or an RPC error). bug.5022: this is the SERVER-SIDE
 * publish backstop — the client-only guard missed the re-fold-changed-root case. Reads
 * are best-effort: a failure falls back to null (the route still serves; the fold FREEZE
 * is the load-bearing money guard, this is defense-in-depth against a stale/non-UI caller).
 */
async function readLiveMerkleRoot(
  chainId: number | null,
  distributorAddress: string
): Promise<string | null> {
  const viemChain = chainId == null ? null : VIEM_CHAINS_BY_ID[chainId];
  const rpcUrl = serverEnv().EVM_RPC_URL;
  if (!viemChain || !rpcUrl) return null;
  try {
    const client = createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl),
    });
    const root = await client.readContract({
      address: distributorAddress as Address,
      abi: MERKLE_ROOT_ABI,
      functionName: "merkleRoot",
    });
    return typeof root === "string" ? root : null;
  } catch {
    return null;
  }
}

/** DTO the ExecuteDistributionPanel consumes to build the createProposal actions. */
interface DistributionTxDto {
  readonly epochId: string;
  readonly merkleRoot: string;
  /** Cumulative-delta to mint into the distributor this epoch, in base units (decimal string). */
  readonly mintDelta: string;
  readonly distributorAddress: string;
  readonly tokenAddress: string;
  readonly daoAddress: string;
  readonly pluginAddress: string;
  readonly chainId: number;
  /** On-chain root the distributor already carries, if the manifest recorded it (else null). */
  readonly alreadyExecutedRoot: string | null;
}

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: ROUTE_ID,
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "invalid epoch id" }, { status: 400 });
    }

    const store = getContainer().attributionStore;

    // FINALIZED_AND_RECORDED: the epoch must be finalized before a distribution exists.
    const epoch = await store.getEpoch(epochId);
    if (!epoch) {
      return NextResponse.json({ error: "epoch_not_found" }, { status: 404 });
    }

    // APPROVER_GATED: node ledger approver (repo-spec) may read. Mirrors the finalize
    // route's approver gate — checks against the epoch's pinned approvers when present.
    const denied = checkApprover(ctx, sessionUser?.walletAddress, epoch);
    if (denied) return denied;

    if (epoch.status !== "finalized") {
      return NextResponse.json(
        { error: "epoch_not_finalized", currentStatus: epoch.status },
        { status: 409 }
      );
    }

    const manifest = await store.getDistributionManifestForEpoch(epochId);
    if (!manifest) {
      return NextResponse.json(
        { error: "no_distribution_manifest" },
        { status: 409 }
      );
    }
    if (!manifest.distributorAddress) {
      // R2/R3 must have recorded the distributor before a mint+setRoot can target it.
      return NextResponse.json(
        { error: "distributor_not_recorded" },
        { status: 409 }
      );
    }

    // NODE_SCOPED (single-node): the DAO + TokenVoting plugin governance addresses come
    // from THIS node's OWN repo-spec — no operator gateway, no nodes-table row.
    const dao = getDaoConfig();
    if (!dao) {
      return NextResponse.json(
        { error: "node_missing_governance" },
        { status: 409 }
      );
    }
    const daoAddress = dao.dao_contract;
    const pluginAddress = dao.plugin_contract;

    // CUMULATIVE_DELTA: mint only the increment over the prior distribution. The prior
    // is the most-recent finalized epoch (by id, ascending) BEFORE this one that has a
    // persisted manifest. First distribution ⇒ no prior manifest ⇒ delta == cumulativeTotal.
    const priorManifest = await findPriorManifest(store, epoch.nodeId, epochId);
    const mintDelta =
      priorManifest === null
        ? manifest.distributionAmount
        : manifest.distributionAmount - priorManifest.distributionAmount;

    if (mintDelta < 0n) {
      // A cumulative total should never shrink. Refuse rather than emit a bad mint.
      return NextResponse.json(
        { error: "negative_mint_delta" },
        { status: 409 }
      );
    }

    // bug.5022 SERVER-SIDE PUBLISH GUARD: read the distributor's LIVE merkle root and
    // refuse to serve a mint payload for a root that is already on-chain. The prior fix
    // was client-only (a stale/non-UI caller or a race could re-submit and double-mint);
    // this closes it server-side. Best-effort: an unreadable root falls back to null and
    // the route still serves (the fold FREEZE is the load-bearing guard — see ledger.ts).
    const alreadyExecutedRoot = await readLiveMerkleRoot(
      manifest.chainId,
      manifest.distributorAddress
    );
    if (
      alreadyExecutedRoot !== null &&
      alreadyExecutedRoot.toLowerCase() === manifest.merkleRoot.toLowerCase()
    ) {
      ctx.log.info(
        {
          event: "ledger.distribution_tx.already_published",
          routeId: ROUTE_ID,
          nodeId: epoch.nodeId,
          epochId: manifest.epochId.toString(),
          merkleRoot: `${manifest.merkleRoot.slice(0, 12)}...`,
        },
        "distribution-tx: refused — epoch root already live on-chain (already_published)"
      );
      return NextResponse.json(
        { error: "already_published", merkleRoot: manifest.merkleRoot },
        { status: 409 }
      );
    }

    const dto: DistributionTxDto = {
      epochId: manifest.epochId.toString(),
      merkleRoot: manifest.merkleRoot,
      mintDelta: mintDelta.toString(),
      distributorAddress: manifest.distributorAddress,
      tokenAddress: manifest.tokenAddress,
      daoAddress,
      pluginAddress,
      chainId: manifest.chainId,
      alreadyExecutedRoot,
    };

    ctx.log.info(
      {
        event: "ledger.distribution_tx.served",
        routeId: ROUTE_ID,
        nodeId: epoch.nodeId,
        epochId: dto.epochId,
        chainId: dto.chainId,
        isFirstDistribution: priorManifest === null,
      },
      "distribution-tx: execute payload served"
    );

    return NextResponse.json(dto);
  }
);

/**
 * Find the manifest of the most-recent finalized epoch (by ascending id) strictly
 * before `epochId` for `nodeId`. Returns null when none exists (first distribution).
 * ALL_MATH_BIGINT: epoch ids are bigint; comparisons and sorting stay bigint.
 */
async function findPriorManifest(
  store: ReturnType<typeof getContainer>["attributionStore"],
  nodeId: string,
  epochId: bigint
) {
  const epochs = await store.listEpochs(nodeId);
  const priorFinalized = epochs
    .filter((e) => e.status === "finalized" && e.id < epochId)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)); // descending by id

  for (const e of priorFinalized) {
    const m = await store.getDistributionManifestForEpoch(e.id);
    if (m) return m;
  }
  return null;
}

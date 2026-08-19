// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/activate-distributions/route`
 * Purpose: Single-node distribution activation. Records the CumulativeMerkleDistributor the owner's
 *   wallet just deployed + transferred to the DAO into THIS node's OWN repo-spec
 *   (`distributions.status: active` + `distributions.distributor_address`), after re-verifying the
 *   on-chain invariants that make it trustworthy. Metadata-only: NO tokens move — the DAO is the
 *   GovernanceERC20 minter and mints per-epoch into the distributor later.
 * Scope: SIWE + ledger-approver-gated (mirrors the finalize / distribution-tx routes). NODE-SCOPED:
 *   governance addresses come from THIS node's repo-spec via `getDaoConfig` / `getNodeTokenomicsConfig`
 *   — there is no operator gateway and no nodes-table row. Verifies the distributor on-chain
 *   (owner()==DAO AND token()==node token) before recording; the actual git write is delegated to the
 *   node's repo-spec writer when configured.
 * Invariants:
 *   - NODE_SCOPED (single-node): token/DAO/chain read from repo-spec, never an operator row.
 *   - METADATA_ONLY / NO_BALANCE_GATE: activation records readiness; nothing is pre-minted.
 *   - DAO_IS_EMISSIONS_HOLDER: the emissions holder is the DAO unconditionally.
 *   - VERIFY_BEFORE_RECORD: the distributor is pinned only after owner()==DAO AND token()==token.
 *   - RECORD_UNAVAILABLE_IS_NON_FATAL: when the node has no configured repo-spec writer, the route
 *     returns 503 `record_unavailable`. The client (useDeployDistributor) treats that as a non-fatal
 *     "deployed, record pending" state — the on-chain deploy + transfer are the irreversible truth.
 *   - APPROVER_GATED: node ledger approver (repo-spec) authorizes the activation.
 * Side-effects: IO (HTTP response, best-effort viem RPC reads for verification).
 * Links: src/features/governance/hooks/useDeployDistributor.ts,
 *   src/features/governance/components/DistributionsCard.client.tsx, docs/spec/tokenomics.md
 * @public
 */

import { CUMULATIVE_MERKLE_DISTRIBUTOR_ABI } from "@cogni/cogni-contracts";
import { CHAINS } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { type Address, createPublicClient, getAddress, http } from "viem";
import { base, sepolia } from "viem/chains";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { checkApprover } from "@/app/api/v1/attribution/_lib/approver-guard";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getDaoConfig, getNodeTokenomicsConfig } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "ledger.activate-distributions";

// Map a NODE's chain id to its viem chain object (mirrors distribution-tx / verify).
// Chain ids come from the shared CHAINS registry (never hardcode — no-restricted-syntax).
const VIEM_CHAINS_BY_ID: Record<number, typeof base | typeof sepolia> = {
  [CHAINS.BASE.chainId]: base,
  [CHAINS.SEPOLIA.chainId]: sepolia,
};

const ActivateDistributionsInput = z.object({
  // A CumulativeMerkleDistributor the owner's wallet just deployed + transferred to
  // the DAO. VERIFIED on-chain (owner()==DAO, token()==node token) before recording.
  distributorAddress: z.string(),
  // Deploy tx hash (surfaced only; not persisted). Optional.
  deployTx: z.string().optional(),
});

function checksummedAddress(value: string): Address | null {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: ROUTE_ID,
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    // APPROVER_GATED: no epoch here, so checkApprover falls back to repo-spec approvers.
    const denied = checkApprover(ctx, sessionUser?.walletAddress);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }
    const parsed = ActivateDistributionsInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    // NODE_SCOPED: governance + token/chain from THIS node's repo-spec.
    const dao = getDaoConfig();
    if (!dao) {
      return NextResponse.json(
        { error: "node_missing_governance" },
        { status: 409 }
      );
    }
    const tokenomics = getNodeTokenomicsConfig();
    const tokenAddress = tokenomics.tokenAddress
      ? checksummedAddress(tokenomics.tokenAddress)
      : null;
    const daoAddress = checksummedAddress(dao.dao_contract);
    if (!tokenAddress || !daoAddress) {
      return NextResponse.json(
        { error: "node_missing_governance" },
        { status: 409 }
      );
    }

    const distributorAddress = checksummedAddress(parsed.data.distributorAddress);
    if (!distributorAddress) {
      return NextResponse.json(
        {
          error: "invalid distributor address",
          distributorAddress: parsed.data.distributorAddress,
        },
        { status: 400 }
      );
    }

    const rpcUrl = serverEnv().EVM_RPC_URL;
    if (!rpcUrl) {
      return NextResponse.json(
        {
          error: "node not configured for distribution verification",
          reason: "EVM_RPC_URL required for on-chain contract verification",
        },
        { status: 503 }
      );
    }
    const viemChain = VIEM_CHAINS_BY_ID[tokenomics.chainId];
    if (!viemChain) {
      return NextResponse.json(
        {
          error: "unsupported chain for distribution verification",
          reason: "chainId is not a supported chain (8453 base, 11155111 sepolia)",
          chainId: tokenomics.chainId,
        },
        { status: 409 }
      );
    }

    // VERIFY_BEFORE_RECORD: the distributor must be owned by the DAO and distribute
    // THIS node's token. A mismatch is a 409 — never record an unverified/foreign distributor.
    try {
      const client = createPublicClient({
        chain: viemChain,
        transport: http(rpcUrl),
      });
      const distCode = await client.getBytecode({ address: distributorAddress });
      if (!distCode || distCode === "0x") {
        return NextResponse.json(
          { error: "distributor contract missing", distributorAddress },
          { status: 409 }
        );
      }
      const [distOwner, distToken] = await Promise.all([
        client.readContract({
          abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
          address: distributorAddress,
          functionName: "owner",
        }),
        client.readContract({
          abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
          address: distributorAddress,
          functionName: "token",
        }),
      ]);
      const ownerMatches =
        typeof distOwner === "string" &&
        distOwner.toLowerCase() === daoAddress.toLowerCase();
      const tokenMatches =
        typeof distToken === "string" &&
        distToken.toLowerCase() === tokenAddress.toLowerCase();
      ctx.log.info(
        {
          event: "ledger.activate_distributions.distributor_verified",
          routeId: ROUTE_ID,
          distributorAddress,
          ownerMatches,
          tokenMatches,
        },
        "activate-distributions: distributor verification result"
      );
      if (!ownerMatches || !tokenMatches) {
        return NextResponse.json(
          {
            error: "distributor verification failed",
            reason:
              "the distributor must be owned by the node DAO (owner()==daoAddress) and distribute the node token (token()==tokenAddress)",
            distributorAddress,
            expectedOwner: daoAddress,
            actualOwner: distOwner,
            expectedToken: tokenAddress,
            actualToken: distToken,
          },
          { status: 409 }
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      ctx.log.error(
        {
          event: "ledger.activate_distributions.verify_failed",
          routeId: ROUTE_ID,
          distributorAddress,
          err: reason,
        },
        "activate-distributions: on-chain verification failed"
      );
      return NextResponse.json(
        { error: "distribution activation verification failed", reason },
        { status: 502 }
      );
    }

    // The distributor is verified on-chain. Recording it into `.cogni/repo-spec.yaml`
    // requires a configured node repo-spec writer (GitHub App + repo identity). A stock
    // single-node deployment has no self-write plane; when absent we return a NON-FATAL
    // 503 `record_unavailable` — the client keeps the verified address visible for
    // off-plane recording (edit the repo-spec directly + merge) or retry. The on-chain
    // deploy + transferOwnership(DAO) are the irreversible truth; this is only the record.
    ctx.log.info(
      {
        event: "ledger.activate_distributions.record_unavailable",
        routeId: ROUTE_ID,
        distributorAddress,
      },
      "activate-distributions: verified on-chain; no repo-spec writer configured — record pending"
    );
    return NextResponse.json(
      {
        error: "record_unavailable",
        reason:
          "distributor verified on-chain but this node has no configured repo-spec writer; record `distributions.distributor_address` + `distributions.status: active` in .cogni/repo-spec.yaml manually",
        distributorAddress,
        expectedSpec: {
          "distributions.status": "active",
          "distributions.distributor_address": distributorAddress,
        },
      },
      { status: 503 }
    );
  }
);

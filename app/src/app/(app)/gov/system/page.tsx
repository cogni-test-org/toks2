// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/system/page`
 * Purpose: Server entrypoint for the system activity page within governance. Also hosts the ONE-TIME
 *   distribution SETUP surface (`DistributionsCard`) — deploy the distributor + authorize publishing —
 *   whose governance addresses are read server-side from THIS node's repo-spec (single-node).
 * Scope: Server component; reads repo-spec governance/tokenomics config and passes it to the client
 *   DistributionsCard. Delegates the rest of the client behavior to GovernanceView. No data fetching.
 * Invariants: Auth enforced by (app) layout guard. NODE_SCOPED — addresses come from getDaoConfig /
 *   getNodeTokenomicsConfig, never a nodes DB row.
 * Side-effects: none (server render only)
 * Links: docs/spec/governance-status-api.md, src/features/governance/components/DistributionsCard.client.tsx
 * @public
 */

import type { ReactElement } from "react";
import { Suspense } from "react";

import { PageSkeleton } from "@/components";
import { DistributionsCard } from "@/features/governance/components/DistributionsCard.client";
import {
  getDaoConfig,
  getNodeName,
  getNodeTokenomicsConfig,
} from "@/shared/config";

import { GovernanceView } from "./view";

export default function SystemActivityPage(): ReactElement {
  const dao = getDaoConfig();
  const tokenomics = getNodeTokenomicsConfig();

  return (
    <div className="space-y-8">
      <DistributionsCard
        slug={getNodeName()}
        repoSpecUrl={null}
        tokenAddress={tokenomics.tokenAddress}
        daoAddress={dao?.dao_contract ?? null}
        pluginAddress={dao?.plugin_contract ?? null}
        chainId={tokenomics.chainId}
        recordedDistributorAddress={tokenomics.distributorAddress}
      />

      <Suspense fallback={<PageSkeleton />}>
        <GovernanceView />
      </Suspense>
    </div>
  );
}

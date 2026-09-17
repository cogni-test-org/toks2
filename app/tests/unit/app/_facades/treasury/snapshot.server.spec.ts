// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/treasury/snapshot.server`
 * Purpose: Unit tests for treasury snapshot facade fallbacks before route wrapping.
 * Scope: Verifies missing DAO config returns a contract-valid stale response without bootstrapping RPC dependencies.
 * Invariants: Public treasury snapshot route must not hard-500 for unactivated template nodes.
 * Side-effects: none
 * Links: app/src/app/_facades/treasury/snapshot.server.ts
 * @public
 */

import { CHAIN_ID } from "@cogni/node-shared";
import type { RequestContext } from "@/shared/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => {
    throw new Error("container should not be initialized without DAO config");
  }),
}));

vi.mock("@/shared/config/repoSpec.server", () => ({
  getDaoConfig: vi.fn(),
}));

import { getTreasurySnapshotFacade } from "@/app/_facades/treasury/snapshot.server";
import { getDaoConfig } from "@/shared/config/repoSpec.server";

function requestContext(): RequestContext {
  return {
    log: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    } as unknown as RequestContext["log"],
    reqId: "req_test",
    traceId: "trace_test",
    routeId: "treasury.snapshot",
    clock: { now: () => "2026-06-27T00:00:00.000Z" },
  };
}

describe("getTreasurySnapshotFacade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a stale empty snapshot when DAO governance identity is not configured", async () => {
    vi.mocked(getDaoConfig).mockReturnValue(null);

    const result = await getTreasurySnapshotFacade(requestContext());

    expect(result).toMatchObject({
      treasuryAddress: "",
      chainId: CHAIN_ID,
      blockNumber: "0",
      balances: [],
      staleWarning: true,
    });
    expect(result.timestamp).toBeGreaterThan(0);
  });
});

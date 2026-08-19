// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/DistributionsCard.client`
 * Purpose: The ONE-TIME distribution SETUP surface for THIS node (single-node) — a single guided
 *   sequence the owner runs once. Two ordered, idempotent on-chain steps:
 *     1. DEPLOY DISTRIBUTOR — the owner's wallet deploys the vendored `CumulativeMerkleDistributor`,
 *        transfers ownership to the DAO, and records the on-chain-verified address (useDeployDistributor).
 *        The record POST also flips `distributions.status: active` in the node repo-spec.
 *     2. AUTHORIZE PUBLISHING — deploy the scoped `DistributionPublishCondition(token, distributor)` and
 *        submit ONE governance proposal granting the wallet SCOPED EXECUTE_PERMISSION
 *        (useAuthorizePublishing). This IS a governance proposal (said so). Once done, every per-epoch
 *        publish is a single direct `DAO.execute` with no vote (on the finalized-epoch page).
 *   Each step shows clear state (done / current / not-yet) and SKIPS when already complete:
 *   distributor recorded ⇒ skip step 1; `hasPermission` true ⇒ skip step 2.
 * Scope: Renders a "Set up distributions" SectionCard. Wallet-gated (wagmi) + chain-gated (the node
 *   chain) for the on-chain steps. The git-authoritative "already done" signal
 *   (recordedDistributorAddress) comes from the page's server-side repo-spec read; the wallet's
 *   `hasPermission` is read on-chain here.
 * Side-effects: IO (POST activate-distributions route, router.refresh), blockchain writes via wallet.
 * Links: src/app/api/v1/attribution/activate-distributions/route.ts,
 *   src/features/governance/hooks/useDeployDistributor.ts,
 *   src/features/governance/hooks/useAuthorizePublishing.ts,
 *   src/features/governance/hooks/useExecuteDistribution.ts (useHasExecutePermission)
 * @public
 */

"use client";

import { getTransactionExplorerUrl } from "@cogni/node-shared";
import { ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";

import { Button, SectionCard, WalletConnectButton } from "@/components";
import {
  StepRow,
  type StepState,
} from "@/features/governance/components/LifecycleStepper";
import { useAuthorizePublishing } from "@/features/governance/hooks/useAuthorizePublishing";
import { useDeployDistributor } from "@/features/governance/hooks/useDeployDistributor";
import { useHasExecutePermission } from "@/features/governance/hooks/useExecuteDistribution";

interface Props {
  readonly slug: string;
  readonly repoSpecUrl: string | null;
  /** The node's GovernanceERC20 token (constructor arg for the distributor). Null hides deploy. */
  readonly tokenAddress: string | null;
  /** The DAO that receives distributor ownership + grants publish authority. Null hides on-chain steps. */
  readonly daoAddress: string | null;
  /** The node's Aragon TokenVoting plugin — createProposal target for the authorize step. */
  readonly pluginAddress: string | null;
  /** The node's chain id — on-chain steps are gated on the connected wallet matching it. */
  readonly chainId: number | null;
  /** Git-authoritative: the distributor address recorded in the spec, if any (skip step 1). */
  readonly recordedDistributorAddress: string | null;
}

export function DistributionsCard({
  slug,
  repoSpecUrl,
  tokenAddress,
  daoAddress,
  pluginAddress,
  chainId,
  recordedDistributorAddress,
}: Props): ReactElement {
  return (
    <SectionCard
      title="Set up distributions"
      className="mx-auto mt-4 w-full max-w-2xl"
    >
      <p className="text-muted-foreground text-sm">
        A one-time setup so <span className="font-medium">{slug}</span> can pay
        contributors in its DAO token. After setup, each epoch publishes in a
        single transaction with no vote.
      </p>

      {tokenAddress && daoAddress && chainId != null ? (
        <SetupSequence
          repoSpecUrl={repoSpecUrl}
          tokenAddress={tokenAddress as `0x${string}`}
          daoAddress={daoAddress as `0x${string}`}
          pluginAddress={
            pluginAddress ? (pluginAddress as `0x${string}`) : null
          }
          chainId={chainId}
          recordedDistributorAddress={
            recordedDistributorAddress
              ? (recordedDistributorAddress as `0x${string}`)
              : null
          }
        />
      ) : (
        <p className="mt-2 text-muted-foreground text-sm">
          Deploy + authorize become available once this node has a token, DAO,
          and chain configured in its repo-spec.
        </p>
      )}
    </SectionCard>
  );
}

/**
 * The two-step guided setup. Reads the wallet's on-chain publish authority so step 2 can skip when
 * already granted. Steps are ordered but each shows its own done/current/not-yet state; a completed
 * step collapses to a compact "done" row.
 */
function SetupSequence({
  repoSpecUrl,
  tokenAddress,
  daoAddress,
  pluginAddress,
  chainId,
  recordedDistributorAddress,
}: {
  repoSpecUrl: string | null;
  tokenAddress: `0x${string}`;
  daoAddress: `0x${string}`;
  pluginAddress: `0x${string}` | null;
  chainId: number;
  recordedDistributorAddress: `0x${string}` | null;
}): ReactElement {
  const { address, isConnected } = useAccount();
  const connectedChainId = useChainId();
  const { switchChain } = useSwitchChain();

  // Step 1 state: the deploy hook drives the live flow; the recorded address makes it idempotent.
  const deploy = useDeployDistributor(tokenAddress, daoAddress);
  const distributorAddress =
    deploy.distributorAddress ?? recordedDistributorAddress;
  const distributorDeployed = distributorAddress !== null;

  // Step 2 gate: does the connected wallet already hold scoped EXECUTE_PERMISSION on the DAO?
  // Probed with token + distributor so the SCOPED condition evaluates a real publish shape
  // (empty "0x" would make the condition deny a live grant → button falsely reappears).
  const { hasPermission, refetch: refetchPermission } = useHasExecutePermission(
    { daoAddress, wallet: address, tokenAddress, distributorAddress, chainId }
  );
  const authorized = hasPermission === true;

  const onCorrectChain = connectedChainId === chainId;

  // Derive the "current" step: the first not-yet-done step in the sequence.
  const currentStep: 1 | 2 | null = !distributorDeployed
    ? 1
    : !authorized
      ? 2
      : null;

  const stepState = (step: 1 | 2): StepState => {
    const done =
      (step === 1 && distributorDeployed) || (step === 2 && authorized);
    if (done) return "done";
    return currentStep === step ? "current" : "pending";
  };

  return (
    <div className="mt-2 space-y-3">
      {/* Wallet + chain gating is shared by both on-chain steps. Surface the connect / switch
          control once, up top. */}
      {!isConnected ? (
        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <p className="mb-2 text-muted-foreground text-sm">
            Connect the node owner wallet to deploy + authorize.
          </p>
          <WalletConnectButton />
        </div>
      ) : !onCorrectChain ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => switchChain?.({ chainId })}
        >
          Switch network to continue setup
        </Button>
      ) : null}

      <DeployStep
        state={stepState(1)}
        chainId={chainId}
        deploy={deploy}
        recordedDistributorAddress={recordedDistributorAddress}
        walletReady={isConnected && onCorrectChain}
      />

      <AuthorizeStep
        state={stepState(2)}
        chainId={chainId}
        tokenAddress={tokenAddress}
        daoAddress={daoAddress}
        pluginAddress={pluginAddress}
        distributorAddress={distributorAddress}
        wallet={address ?? null}
        walletReady={isConnected && onCorrectChain}
        onAuthorized={refetchPermission}
      />

      {repoSpecUrl ? (
        <ExternalLinkRow href={repoSpecUrl}>View repo-spec</ExternalLinkRow>
      ) : null}
    </div>
  );
}

/**
 * Step 1 — deploy the distributor. The wallet deploys the vendored CumulativeMerkleDistributor, transfers
 * ownership to the DAO, and records the on-chain-verified address. Skips when a distributor is already
 * recorded in the spec.
 */
function DeployStep({
  state,
  chainId,
  deploy,
  recordedDistributorAddress,
  walletReady,
}: {
  state: StepState;
  chainId: number;
  deploy: ReturnType<typeof useDeployDistributor>;
  recordedDistributorAddress: `0x${string}` | null;
  walletReady: boolean;
}): ReactElement {
  const router = useRouter();
  const {
    phase,
    distributorAddress,
    deployTx,
    transferTx,
    prUrl,
    recordError,
    error,
    deploy: runDeploy,
  } = deploy;

  const busy =
    phase === "deploying" || phase === "transferring" || phase === "recording";
  const deployTxUrl = deployTx
    ? getTransactionExplorerUrl(chainId, deployTx)
    : null;
  const transferTxUrl = transferTx
    ? getTransactionExplorerUrl(chainId, transferTx)
    : null;

  // Refresh once the PR is recorded so the git-authoritative page read reflects it.
  // MUST be an effect, not a render-body call — a render-body router.refresh() re-fires
  // on every re-render while phase stays "done" (a refresh loop).
  useEffect(() => {
    if (phase === "done" && prUrl) router.refresh();
  }, [phase, prUrl, router]);

  if (state === "done") {
    const shown = distributorAddress ?? recordedDistributorAddress;
    return (
      <StepRow n={1} state="done" title="Distributor deployed">
        {shown ? (
          <p className="break-all font-mono text-muted-foreground text-xs">
            Distributor: {shown}
          </p>
        ) : null}
      </StepRow>
    );
  }

  const phaseLabel =
    phase === "deploying"
      ? "Deploying distributor… confirm in wallet"
      : phase === "transferring"
        ? "Transferring ownership to the DAO… confirm in wallet"
        : phase === "recording"
          ? "Verifying on-chain + recording in the repo-spec…"
          : null;

  return (
    <StepRow n={1} state={state} title="Deploy distributor">
      {state === "current" ? (
        <>
          <p className="text-muted-foreground text-sm">
            Your wallet deploys the vendored CumulativeMerkleDistributor for
            this node&apos;s token and transfers ownership to the DAO. The node
            then verifies on-chain (DAO owns it, its token matches) and records
            the address so contributors can claim.
          </p>

          <Button
            type="button"
            onClick={runDeploy}
            disabled={busy || !walletReady}
            className="gap-2"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {phase === "done" ? "Redeploy distributor" : "Deploy distributor"}
          </Button>

          {phaseLabel ? (
            <p className="text-muted-foreground text-sm">{phaseLabel}</p>
          ) : null}
          {deployTxUrl ? (
            <ExternalLinkRow href={deployTxUrl}>
              Deploy transaction
            </ExternalLinkRow>
          ) : null}
          {transferTxUrl ? (
            <ExternalLinkRow href={transferTxUrl}>
              Transfer-ownership transaction
            </ExternalLinkRow>
          ) : null}
          {distributorAddress ? (
            <p className="break-all font-mono text-muted-foreground text-xs">
              Distributor: {distributorAddress}
            </p>
          ) : null}
          {phase === "done" && recordError ? (
            <p className="text-muted-foreground text-sm">
              ✅ Deployed on-chain + ownership transferred to the DAO.
              Git-record pending (the repo-spec writer isn&apos;t configured for
              this node):{" "}
              <span className="font-mono text-xs">{recordError}</span>
            </p>
          ) : null}
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </>
      ) : null}
    </StepRow>
  );
}

/**
 * Step 2 — authorize publishing (a governance proposal). Deploys the scoped
 * DistributionPublishCondition(token, distributor) and submits ONE grantWithCondition proposal so the
 * wallet gains SCOPED standing publish authority. Skips when `hasPermission` is already true.
 */
function AuthorizeStep({
  state,
  chainId,
  tokenAddress,
  daoAddress,
  pluginAddress,
  distributorAddress,
  wallet,
  walletReady,
  onAuthorized,
}: {
  state: StepState;
  chainId: number;
  tokenAddress: `0x${string}`;
  daoAddress: `0x${string}`;
  pluginAddress: `0x${string}` | null;
  distributorAddress: `0x${string}` | null;
  wallet: `0x${string}` | null;
  walletReady: boolean;
  onAuthorized: () => void;
}): ReactElement {
  if (state === "done") {
    return (
      <StepRow n={2} state="done" title="Publishing authorized">
        <p className="text-muted-foreground text-sm">
          Your wallet holds scoped authority to publish this node&apos;s
          distributions — and nothing else.
        </p>
      </StepRow>
    );
  }

  return (
    <StepRow n={2} state={state} title="Authorize publishing">
      {state === "current" ? (
        <AuthorizeStepBody
          chainId={chainId}
          tokenAddress={tokenAddress}
          daoAddress={daoAddress}
          pluginAddress={pluginAddress}
          distributorAddress={distributorAddress}
          wallet={wallet}
          walletReady={walletReady}
          onAuthorized={onAuthorized}
        />
      ) : (
        <p className="pl-0 text-muted-foreground text-sm">
          Grant your wallet scoped authority to publish — after the distributor
          is deployed.
        </p>
      )}
    </StepRow>
  );
}

/** The live authorize flow (only mounted when step 2 is the current step + all inputs are present). */
function AuthorizeStepBody({
  chainId,
  tokenAddress,
  daoAddress,
  pluginAddress,
  distributorAddress,
  wallet,
  walletReady,
  onAuthorized,
}: {
  chainId: number;
  tokenAddress: `0x${string}`;
  daoAddress: `0x${string}`;
  pluginAddress: `0x${string}` | null;
  distributorAddress: `0x${string}` | null;
  wallet: `0x${string}` | null;
  walletReady: boolean;
  onAuthorized: () => void;
}): ReactElement {
  const ready = Boolean(
    walletReady && wallet && pluginAddress && distributorAddress
  );

  const { phase, deployTx, grantTx, error, authorize } = useAuthorizePublishing(
    {
      token: tokenAddress,
      distributor:
        distributorAddress ?? "0x0000000000000000000000000000000000000000",
      dao: daoAddress,
      plugin: pluginAddress ?? "0x0000000000000000000000000000000000000000",
      wallet: wallet ?? "0x0000000000000000000000000000000000000000",
    }
  );

  // Re-read the on-chain permission the moment the grant confirms so the sequence advances.
  // Effect, not render-body — otherwise onAuthorized re-fires every re-render at phase "done".
  useEffect(() => {
    if (phase === "done") onAuthorized();
  }, [phase, onAuthorized]);

  const busy = phase === "deploying" || phase === "granting";
  const explorerTx = grantTx ?? deployTx;
  const explorerUrl = explorerTx
    ? getTransactionExplorerUrl(chainId, explorerTx)
    : null;
  const label =
    phase === "deploying"
      ? "Deploying condition… confirm in wallet"
      : phase === "granting"
        ? "Submitting grant proposal…"
        : "Authorize publishing";

  return (
    <>
      <p className="text-muted-foreground text-sm">
        Grants your wallet permission to publish THIS node&apos;s distributions
        and nothing else (enforced on-chain by a scoped condition contract).
        This IS a governance proposal — two transactions, deploy the condition
        then submit the grant — run once. After this, each epoch publishes in a
        single transaction with no vote.
      </p>

      {!pluginAddress ? (
        <p className="text-muted-foreground text-sm">
          This node is missing its voting-plugin address; authorize can&apos;t
          run yet.
        </p>
      ) : null}

      <Button
        type="button"
        onClick={authorize}
        disabled={busy || !ready}
        className="gap-2"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {label}
      </Button>

      {explorerUrl && busy ? (
        <ExternalLinkRow href={explorerUrl}>
          {grantTx ? "View proposal transaction" : "View deploy transaction"}
        </ExternalLinkRow>
      ) : null}

      {error ? (
        <p className="text-destructive text-sm">
          {error.message?.includes("User rejected")
            ? "Transaction cancelled."
            : (error.message ?? "Authorization failed")}
        </p>
      ) : null}
    </>
  );
}

/** A small external-link row (icon + label), matching the neighboring idiom. */
function ExternalLinkRow({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}): ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline"
    >
      {children}
      <ExternalLink className="size-3.5" />
    </a>
  );
}

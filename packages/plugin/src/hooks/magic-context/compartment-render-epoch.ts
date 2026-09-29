export const COMPARTMENT_RENDER_EPOCH = "cre2";
export const MEMORY_RENDER_FORMAT_EPOCH = "mre3";

const EPOCH_COMPONENT_PREFIX = "|compartment-render:";
const MEMORY_EPOCH_COMPONENT_PREFIX = "|memory-render:";
const MURAL_COMPONENT_PREFIX = "|mural-enabled:";
const BUDGET_COMPONENT_PREFIX = "|render-budgets:";

export interface CachedM0UpgradeIdentity {
    upgradeState: string | null;
    compartmentRenderEpoch: string | null;
    memoryRenderEpoch: string | null;
    muralEnabled: boolean | null;
    renderBudgetIdentity: string | null;
}

/**
 * Store renderer and render-config identity in the existing cached upgrade-state marker.
 * Provider-visible byte changes must change this identity so each cached m[0] folds exactly once.
 */
export function encodeCachedM0UpgradeIdentity(
    upgradeState: string | null,
    compartmentRenderEpoch: string | null = COMPARTMENT_RENDER_EPOCH,
    muralEnabled: boolean | null = null,
    renderBudgetIdentity: string | null = null,
    memoryRenderEpoch: string | null = MEMORY_RENDER_FORMAT_EPOCH,
): string | null {
    let encoded = upgradeState ?? "";
    if (compartmentRenderEpoch !== null) {
        encoded += `${EPOCH_COMPONENT_PREFIX}${compartmentRenderEpoch}`;
    }
    if (memoryRenderEpoch !== null) {
        encoded += `${MEMORY_EPOCH_COMPONENT_PREFIX}${memoryRenderEpoch}`;
    }
    if (muralEnabled !== null) {
        encoded += `${MURAL_COMPONENT_PREFIX}${muralEnabled ? "1" : "0"}`;
    }
    if (renderBudgetIdentity !== null) {
        encoded += `${BUDGET_COMPONENT_PREFIX}${renderBudgetIdentity}`;
    }
    return encoded.length > 0 ? encoded : null;
}

function component(value: string, prefix: string): string | null {
    const start = value.lastIndexOf(prefix);
    if (start < 0) return null;
    const valueStart = start + prefix.length;
    const end = value.indexOf("|", valueStart);
    const result = value.slice(valueStart, end < 0 ? value.length : end);
    return result.length > 0 ? result : null;
}

export function decodeCachedM0UpgradeIdentity(value: string | null): CachedM0UpgradeIdentity {
    if (value === null) {
        return {
            upgradeState: null,
            compartmentRenderEpoch: null,
            memoryRenderEpoch: null,
            muralEnabled: null,
            renderBudgetIdentity: null,
        };
    }
    const componentIndexes = [
        value.indexOf(EPOCH_COMPONENT_PREFIX),
        value.indexOf(MEMORY_EPOCH_COMPONENT_PREFIX),
        value.indexOf(MURAL_COMPONENT_PREFIX),
        value.indexOf(BUDGET_COMPONENT_PREFIX),
    ].filter((index) => index >= 0);
    const identityEnd = componentIndexes.length > 0 ? Math.min(...componentIndexes) : value.length;
    const upgradeState = value.slice(0, identityEnd);
    const muralComponent = component(value, MURAL_COMPONENT_PREFIX);
    return {
        upgradeState: upgradeState.length > 0 ? upgradeState : null,
        compartmentRenderEpoch: component(value, EPOCH_COMPONENT_PREFIX),
        memoryRenderEpoch: component(value, MEMORY_EPOCH_COMPONENT_PREFIX),
        muralEnabled: muralComponent === "1" ? true : muralComponent === "0" ? false : null,
        renderBudgetIdentity: component(value, BUDGET_COMPONENT_PREFIX),
    };
}

/** Compare recorded render budgets while lazily adopting older numeric history identities. */
export function renderBudgetIdentityChanged(cached: string, current: string): boolean {
    const legacy = /^(m[^-]+)-h\d+$/.exec(cached);
    if (legacy && current.startsWith("m") && current.includes("-hp")) {
        // Older history numbers include the observed model window, not just user
        // config. They cannot identify a policy edit. Record the new history policy
        // when another trigger rebuilds m[0]; a changed absolute memory budget must
        // still rebuild immediately.
        return legacy[1] !== current.slice(0, current.indexOf("-h"));
    }
    return cached !== current;
}

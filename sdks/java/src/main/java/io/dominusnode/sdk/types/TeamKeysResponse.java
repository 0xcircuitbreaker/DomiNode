package io.dominusnode.sdk.types;

import java.util.List;

/**
 * Response from listing team API keys.
 */
public final class TeamKeysResponse {

    private List<TeamKey> keys;

    public List<TeamKey> getKeys() { return keys; }
}

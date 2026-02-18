package io.dominusnode.sdk.resources;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.internal.HttpClient;
import io.dominusnode.sdk.types.SlotsInfo;
import io.dominusnode.sdk.types.WaitlistCount;
import io.dominusnode.sdk.types.WaitlistJoinResult;

import java.util.Map;

/**
 * Slot availability and waitlist operations.
 * All methods are public (no authentication required).
 */
public final class SlotsResource {

    private final HttpClient http;

    /**
     * @param http the HTTP client
     */
    public SlotsResource(HttpClient http) {
        this.http = http;
    }

    /**
     * Check available registration slots.
     *
     * @return slot availability information
     * @throws DominusNodeException on API errors
     */
    public SlotsInfo getSlots() throws DominusNodeException {
        return http.get("/api/slots", SlotsInfo.class, false);
    }

    /**
     * Join the waitlist when registration slots are full.
     *
     * @param email email address to add to the waitlist
     * @return join result with confirmation message
     * @throws DominusNodeException on API errors
     */
    public WaitlistJoinResult joinWaitlist(String email) throws DominusNodeException {
        return http.post("/api/waitlist/join", Map.of("email", email), WaitlistJoinResult.class, false);
    }

    /**
     * Get the number of people on the waitlist.
     *
     * @return waitlist count
     * @throws DominusNodeException on API errors
     */
    public WaitlistCount getWaitlistCount() throws DominusNodeException {
        return http.get("/api/waitlist/count", WaitlistCount.class, false);
    }
}

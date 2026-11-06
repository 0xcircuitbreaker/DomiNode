package io.dominusnode.sdk.proxy;

import java.net.InetAddress;
import java.util.Arrays;
import java.util.List;

/** Resolves a hostname to ALL its addresses (A + AAAA). Injectable for tests. */
@FunctionalInterface
public interface HostResolver {
    List<InetAddress> resolveAll(String host) throws Exception;

    HostResolver SYSTEM = host -> Arrays.asList(InetAddress.getAllByName(host));
}

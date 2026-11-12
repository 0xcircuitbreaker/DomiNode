package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.internal.Validation;

import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.Spliterator;
import java.util.Spliterators;
import java.util.function.BiFunction;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;

/**
 * Lazy pagination helpers: iterators fetch the next page only when the current one is exhausted.
 * API errors propagate from {@code hasNext()}/{@code next()}.
 */
public final class Paging {
    /** Server cursor format for /v1/credits/transactions. */
    public static final Pattern CURSOR_RE = Pattern.compile("^[1-9][0-9]{0,18}$");
    static final int MAX_OFFSET = 1_000_000;

    private Paging() {}

    static int pageSize(Integer limit, int def, int max) {
        int l = limit == null ? def : limit;
        Validation.intRange(l, "limit", 1, max);
        return l;
    }

    static <T> Stream<T> stream(Iterator<T> it) {
        return StreamSupport.stream(Spliterators.spliteratorUnknownSize(it, Spliterator.ORDERED | Spliterator.NONNULL), false);
    }

    /** Offset pagination: fetch(limit, offset) returns a page; items are read from {@code itemsField}. */
    static Iterator<JsonNode> offset(int limit, String itemsField, boolean useTotal, BiFunction<Integer, Integer, JsonNode> fetch) {
        return new BufferedIterator() {
            private int offset = 0;

            @Override
            JsonNode fetchPage() {
                JsonNode page = fetch.apply(limit, offset);
                JsonNode items = page == null ? null : page.path(itemsField);
                int n = items != null && items.isArray() ? items.size() : 0;
                if (n > 0) items.forEach(buf::add);
                boolean reachedTotal = false;
                if (useTotal && page != null) {
                    JsonNode total = page.path("pagination").path("total");
                    reachedTotal = total.canConvertToLong() && total.asLong() > 0 && offset + n >= total.asLong();
                }
                offset += limit;
                done = n < limit || reachedTotal || offset > MAX_OFFSET;
                return page;
            }
        };
    }

    /** Cursor pagination following {@code nextCursor}; fetch(cursor) returns a page. */
    static Iterator<JsonNode> cursor(String start, Function<String, JsonNode> fetch) {
        return new BufferedIterator() {
            private String cursor = start;

            @Override
            JsonNode fetchPage() {
                JsonNode page = fetch.apply(cursor);
                JsonNode items = page == null ? null : page.path("transactions");
                int n = items != null && items.isArray() ? items.size() : 0;
                if (n > 0) items.forEach(buf::add);
                JsonNode next = page == null ? null : page.path("nextCursor");
                String nc = next != null && next.isTextual() ? next.asText() : null;
                if (n == 0 || nc == null || !CURSOR_RE.matcher(nc).matches() || nc.equals(cursor)) {
                    done = true;
                } else {
                    cursor = nc;
                }
                return page;
            }
        };
    }

    private abstract static class BufferedIterator implements Iterator<JsonNode> {
        final ArrayDeque<JsonNode> buf = new ArrayDeque<>();
        boolean done = false;

        abstract JsonNode fetchPage();

        @Override
        public boolean hasNext() {
            while (buf.isEmpty() && !done) fetchPage();
            return !buf.isEmpty();
        }

        @Override
        public JsonNode next() {
            if (!hasNext()) throw new NoSuchElementException();
            return buf.poll();
        }
    }
}

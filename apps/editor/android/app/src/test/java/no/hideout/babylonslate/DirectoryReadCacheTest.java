package no.hideout.babylonslate;

import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

public class DirectoryReadCacheTest {
    @Test
    public void indexesNamesAndPreservesDirectoryOrder() {
        DirectoryReadCache<String> cache = new DirectoryReadCache<>(3);
        cache.put("assets", Arrays.asList("b", "a", "a"), value -> value);
        assertEquals(Arrays.asList("b", "a", "a"), cache.get("assets").entries);
        assertEquals("a", cache.get("assets").byName.get("a"));
        assertNull(cache.get("assets").byName.get("missing"));
        cache.clear();
        assertNull(cache.get("assets"));
    }

    @Test
    public void boundsRetainedEntriesAndDoesNotCacheOversizedDirectories() {
        DirectoryReadCache<String> cache = new DirectoryReadCache<>(3);
        cache.put("first", Arrays.asList("a", "b"), value -> value);
        cache.put("empty", Collections.emptyList(), value -> value);
        cache.get("first");
        cache.put("last", Collections.singletonList("c"), value -> value);
        assertNull(cache.get("empty"));
        assertNotNull(cache.get("first"));
        cache.put("huge", Arrays.asList("a", "b", "c", "d"), value -> value);
        assertNull(cache.get("huge"));
        assertNotNull(cache.get("last"));
    }

    @Test
    public void separateOperationsCannotReuseAnOldListing() {
        DirectoryReadCache<String> first = new DirectoryReadCache<>(3);
        DirectoryReadCache<String> second = new DirectoryReadCache<>(3);
        first.put("assets", Collections.singletonList("old"), value -> value);
        second.put("assets", Collections.singletonList("new"), value -> value);
        first.clear();
        assertNull(first.get("assets"));
        assertEquals(Collections.singletonList("new"), second.get("assets").entries);
    }
}

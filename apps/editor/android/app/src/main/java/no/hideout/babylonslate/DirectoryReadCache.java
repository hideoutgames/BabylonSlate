package no.hideout.babylonslate;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/** One read operation's directory listings, bounded by retained entry count. */
final class DirectoryReadCache<T> {
    static final class Directory<T> {
        final List<T> entries;
        final Map<String, T> byName;

        Directory(List<T> entries, Function<T, String> name) {
            this.entries = Collections.unmodifiableList(new ArrayList<>(entries));
            Map<String, T> index = new HashMap<>();
            for (T entry : entries) index.putIfAbsent(name.apply(entry), entry);
            this.byName = Collections.unmodifiableMap(index);
        }

        int cost() { return Math.max(1, entries.size()); }
    }

    private final int capacity;
    private final LinkedHashMap<String, Directory<T>> directories = new LinkedHashMap<>(16, 0.75f, true);
    private int retained;

    DirectoryReadCache(int capacity) { this.capacity = capacity; }

    Directory<T> get(String parent) { return directories.get(parent); }

    void put(String parent, List<T> entries, Function<T, String> name) {
        Directory<T> previous = directories.remove(parent);
        if (previous != null) retained -= previous.cost();
        int cost = Math.max(1, entries.size());
        if (cost > capacity) return;
        while (retained + cost > capacity) {
            String oldest = directories.keySet().iterator().next();
            retained -= directories.remove(oldest).cost();
        }
        directories.put(parent, new Directory<>(entries, name));
        retained += cost;
    }

    void clear() {
        directories.clear();
        retained = 0;
    }
}

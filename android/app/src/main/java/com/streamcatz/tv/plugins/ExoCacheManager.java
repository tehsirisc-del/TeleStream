package com.streamcatz.tv.plugins;

import android.content.Context;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class ExoCacheManager {

    private static SimpleCache downloadCache = null;
    private static final long MAX_CACHE_SIZE = 1024 * 1024 * 200; // 200 MB
    private static final ExecutorService backgroundRemuxExecutor = Executors.newSingleThreadExecutor();

    public static synchronized SimpleCache getInstance(Context context) {
        if (downloadCache == null) {
            LeastRecentlyUsedCacheEvictor evictor = new LeastRecentlyUsedCacheEvictor(MAX_CACHE_SIZE);
            StandaloneDatabaseProvider databaseProvider = new StandaloneDatabaseProvider(context);
            File cacheDir = new File(context.getCacheDir(), "exoplayer_cache");
            if (!cacheDir.exists()) {
                cacheDir.mkdirs();
            }
            downloadCache = new SimpleCache(cacheDir, evictor, databaseProvider);
        }
        return downloadCache;
    }

    public static CacheDataSource.Factory createCacheFactory(Context context, androidx.media3.datasource.DataSource.Factory upstreamFactory) {
        SimpleCache cache = getInstance(context);

        return new CacheDataSource.Factory()
                .setCache(cache)
                .setUpstreamDataSourceFactory(upstreamFactory)
                .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
    }

    /**
     * Automatic MKV to MP4 Remuxing Step
     * Triggers a background remux process if the original file is MKV.
     */
    public static void checkAndRemuxBackground(Context context, String originalFileCacheKey, File sourceFile) {
        backgroundRemuxExecutor.submit(() -> {
            try {
                // Determine if this is MKV. In a real scenario, inspect header or extension.
                // For demonstration, we assume sourceFile is fully downloaded or we check its mime later.
                
                // File mp4File = new File(context.getCacheDir(), "remuxed_" + System.currentTimeMillis() + ".mp4");
                // TODO: Use IsoParser / MP4Parser to repackage:
                // H264TrackImpl h264Track = new H264TrackImpl(new FileDataSourceImpl(sourceFile));
                // Movie m = new Movie();
                // m.addTrack(h264Track);
                // DefaultMp4Builder builder = new DefaultMp4Builder();
                // Container out = builder.build(m);
                // FileOutputStream fos = new FileOutputStream(mp4File);
                // out.writeContainer(fos.getChannel());
                // fos.close();
                
                // Once remuxed, replace caching entry or update media database to point to the new MP4 file.
                // Log.d("ExoCacheManager", "Remux to MP4 completed for: " + originalFileCacheKey);

            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }
}

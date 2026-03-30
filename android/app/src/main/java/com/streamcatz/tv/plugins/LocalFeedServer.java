package com.streamcatz.tv.plugins;

import android.util.Log;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class LocalFeedServer extends Thread {

    private static final String TAG = "LocalFeedServer";
    private static final int PORT = 9992;
    private static final int CHUNK_SIZE = 128 * 1024;

    private ServerSocket serverSocket;
    private boolean running = true;
    private BridgeDataSource activeDataSource;
    private final ExecutorService executor = Executors.newFixedThreadPool(4);

    public void setActiveDataSource(BridgeDataSource source) {
        this.activeDataSource = source;
    }

    public void stopServer() {
        running = false;
        try {
            if (serverSocket != null)
                serverSocket.close();
        } catch (Exception ignored) {
        }
        executor.shutdownNow();
    }

    @Override
    public void run() {
        try {
            // כמו קוד א׳ – רק localhost
            serverSocket = new ServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1"));
            Log.d(TAG, "LocalFeedServer started on 127.0.0.1:" + PORT);

            while (running) {
                Socket client = serverSocket.accept();
                executor.execute(() -> handleClient(client));
            }

        } catch (Exception e) {
            if (running) {
                Log.e(TAG, "Server error: " + e.getMessage());
            }
        }
    }

    private void handleClient(Socket client) {
        try {
            InputStream in = client.getInputStream();
            OutputStream out = client.getOutputStream();

            StringBuilder headers = new StringBuilder();
            int c;

            // קריאת headers
            while ((c = in.read()) != -1) {
                headers.append((char) c);
                if (headers.length() >= 4 &&
                        headers.substring(headers.length() - 4).equals("\r\n\r\n")) {
                    break;
                }
            }

            String headerStr = headers.toString();
            String[] lines = headerStr.split("\r\n");

            String method = "";
            String path = "";
            long contentLength = -1;
            long reqId = -1;
            long offset = 0;

            // שורת request
            if (lines.length > 0) {
                String[] parts = lines[0].split(" ");
                if (parts.length >= 2) {
                    method = parts[0];
                    path = parts[1];
                }
            }

            // headers
            for (String line : lines) {
                if (line.toLowerCase().startsWith("content-length:")) {
                    contentLength = Long.parseLong(line.substring(15).trim());
                }
            }

            // OPTIONS (CORS)
            if ("OPTIONS".equals(method)) {
                sendResponse(out, 200, "text/plain", "");
                return;
            }

            // POST /feed
            if ("POST".equals(method) && path.startsWith("/feed")) {

                // extract reqId
                String[] querySplit = path.split("\\?");
                if (querySplit.length > 1) {
                    String[] params = querySplit[1].split("&");
                    for (String param : params) {
                        if (param.startsWith("reqId=")) {
                            reqId = Long.parseLong(param.substring(6));
                        }
                        if (param.startsWith("offset=")) {
                            offset = Long.parseLong(param.substring(7));
                        }
                    }
                }

                if (contentLength > 0 && activeDataSource != null) {

                    byte[] buffer = new byte[CHUNK_SIZE];
                    int accPos = 0;
                    long readSoFar = 0;

                    while (readSoFar < contentLength) {
                        int toRead = (int) Math.min(CHUNK_SIZE - accPos, contentLength - readSoFar);
                        int bytesRead = in.read(buffer, accPos, toRead);

                        if (bytesRead == -1)
                            break;

                        accPos += bytesRead;
                        readSoFar += bytesRead;

                        if (accPos == CHUNK_SIZE || readSoFar == contentLength) {
                            byte[] chunk = new byte[accPos];
                            System.arraycopy(buffer, 0, chunk, 0, accPos);

                            long chunkOffset = offset + (readSoFar - accPos);
                            boolean accepted = activeDataSource.feedDataBlocking(chunk, reqId, chunkOffset);
                            if (!accepted)
                                break;

                            accPos = 0;
                        }
                    }

                } else if (contentLength == 0 && activeDataSource != null) {
                    // EOF
                    activeDataSource.feedDataBlocking(new byte[0], reqId, offset);
                }

                sendResponse(out, 200, "application/json", "{\"success\":true}");

            } else {
                sendResponse(out, 404, "text/plain", "Not Found");
            }

        } catch (Exception e) {
            Log.e(TAG, "Client error: " + e.getMessage());
        } finally {
            try {
                client.close();
            } catch (Exception ignored) {
            }
        }
    }

    private void sendResponse(OutputStream out, int code, String type, String body) throws Exception {
        byte[] bodyBytes = body.getBytes("UTF-8");

        String response = "HTTP/1.1 " + code + (code == 200 ? " OK" : " Error") + "\r\n" +
                "Content-Type: " + type + "; charset=utf-8\r\n" +
                "Content-Length: " + bodyBytes.length + "\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type\r\n" +
                "Connection: close\r\n\r\n";

        out.write(response.getBytes("UTF-8"));
        out.write(bodyBytes);
        out.flush();
    }
}
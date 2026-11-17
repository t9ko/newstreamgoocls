# Experimental Railway video proxy

This is an experiment, not a guaranteed working StreameX player. It forwards only GET and HEAD requests to www.streamex.hn, and omits upstream frame/security policy headers. It does not rewrite frame-busting JavaScript, external URLs, cookies, sign-ins, streaming providers or DRM. Any of these can prevent the site or player from working. Do not use it for logins or sensitive information. Obtain permission where needed and use only content you are authorized to watch.

1. Put this folder's `package.json` and `server.js` in a new GitHub repository (not inside a subfolder). In Railway create a new project, choose **Deploy from GitHub repo**, and select that repository. Railway should run `npm start` automatically.
2. In the service's **Settings > Networking**, choose **Generate Domain**. Copy the resulting HTTPS URL.
3. In the separate `s3-updates/config.js`, put that URL inside `VIDEO_PROXY_URL`, for example `export const VIDEO_PROXY_URL = 'https://your-service.up.railway.app';` Use your real address. Keep the other Firebase settings unchanged.
4. Upload the three files in `s3-updates` to the same S3 folder as your existing site: `study.html`, `app.js`, and `config.js`. Hard-refresh the page (Ctrl+F5). Select Videos > **Try in page**.
5. If it fails, use **Open set site** instead. The S3 page must be opened via HTTPS to embed an HTTPS Railway service. Railway usage may incur charges; monitor usage and shut down the service if unused.

Security: this is a public endpoint without authentication, intentionally fixed to one upstream. Rate limiting is not included; exposing it can incur bandwidth and usage costs. It deliberately does not forward cookies or proxy unrelated destinations. Host the proxy on a separate origin from your Firebase app, as intended. Never expose secrets in the proxy.

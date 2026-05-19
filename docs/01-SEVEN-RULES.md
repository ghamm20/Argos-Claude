# The Seven USB-Native Rules

Hard gates, not guidelines. Every commit checked against these.

1. Zero host persistence — no writes outside ARGOS_ROOT
2. Zero registry/system config writes — state lives in ARGOS/config/
3. Relative paths only — never hardcode user paths
4. Scoped env vars — child processes only, never modify user shell
5. Network-off by default — no CDN, no analytics, no update check
6. Graceful eject — clean shutdown within 3 seconds
7. Single-binary mentality — no npm install on user machine

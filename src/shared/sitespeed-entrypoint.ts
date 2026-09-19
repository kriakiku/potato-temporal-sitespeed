/**
 * Bash wrapper matching production: install Potato MITM CA, then exec /start.sh.
 */
export function sitespeedPotatoEntrypoint(args: string[]): {
  entrypoint: string[];
  cmd: string[];
} {
  const script = [
    "set +e",
    'CA=/potato-data/ca/potatonetwork-ca.pem',
    'if [ -f "$CA" ]; then',
    "  mkdir -p /usr/local/share/ca-certificates /etc/ssl/certs 2>/dev/null",
    '  cp "$CA" /usr/local/share/ca-certificates/potatonetwork.crt 2>/dev/null',
    '  cp "$CA" /etc/ssl/certs/potatonetwork.pem 2>/dev/null',
    "  command -v update-ca-certificates >/dev/null && update-ca-certificates >/dev/null 2>&1",
    '  if command -v certutil >/dev/null; then',
    '    for db in /root/.pki/nssdb /tmp/.pki/nssdb; do',
    '      mkdir -p "$db" 2>/dev/null',
    '      if [ ! -f "$db/cert9.db" ] && [ ! -f "$db/cert8.db" ]; then',
    '        certutil -d "sql:$db" -N --empty-password >/dev/null 2>&1',
    "      fi",
    '      certutil -d "sql:$db" -D -n potatonetwork >/dev/null 2>&1',
    '      certutil -d "sql:$db" -A -t "C,," -n potatonetwork -i "$CA" >/dev/null 2>&1',
    "    done",
    "  fi",
    "fi",
    "set -e",
    'exec /start.sh "$@"',
  ].join("\n");

  return {
    entrypoint: ["/bin/bash", "-c"],
    cmd: [script, "sitespeed-wrap", ...args],
  };
}

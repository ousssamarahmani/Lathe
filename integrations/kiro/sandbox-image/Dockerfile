# Lathe agent sandbox image (task P4-02): Kiro CLI in a minimal non-root image.
# Build: docker build -t lathe/sandbox:p4-02 integrations/kiro/sandbox-image
# Then pin the result by digest in the SandboxSpec (`lathe/sandbox@sha256:...`).
# Runtime hardening (read-only root, cap-drop, limits, network) is applied by
# `docker run` flags from src/sandbox/docker-args.ts, not by this file.

# debian:bookworm-slim, pinned by index digest (looked up 2026-11-21).
FROM debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e

# Kiro CLI version tested in spike P0-04 (docs/spikes/kiro-acp.md).
ARG KIRO_CLI_VERSION=3.4.0

# Only what the installer and Kiro's tools need: certificates, curl, unzip, git.
# git is needed by agent tools inside the worktree; no compilers, no sudo, no ssh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip git \
 && rm -rf /var/lib/apt/lists/*

# Download the pinned release zip (x86_64 linux, glibc), verify its sha256, and
# install only the binary. The installer script is not used because it always
# fetches "latest". The build fails on a hash or version mismatch.
# To bump: change both ARGs; compute the hash from the downloaded zip.
ARG KIRO_CLI_SHA256=95b85a724ecda5340cc5c98ddc979f4d0a6e96712fb29a36b3e7afaf6c70d389
RUN curl -fsSL "https://desktop-release.q.us-east-1.amazonaws.com/${KIRO_CLI_VERSION}/kirocli-x86_64-linux.zip" -o /tmp/kirocli.zip \
 && echo "${KIRO_CLI_SHA256}  /tmp/kirocli.zip" | sha256sum -c - \
 && unzip -q /tmp/kirocli.zip -d /tmp/kirocli \
 && install -m 0755 /tmp/kirocli/kirocli/bin/kiro-cli /usr/local/bin/kiro-cli \
 && rm -rf /tmp/kirocli /tmp/kirocli.zip \
 && kiro-cli --version | tee /kiro-version.txt \
 && grep -F "${KIRO_CLI_VERSION}" /kiro-version.txt

# Fixed uid/gid, no login shell. HOME is a tmpfs at runtime; the Kiro session
# volume (C2 `kiro-session`) is mounted at /home/agent/.kiro.
RUN useradd --uid 10001 --user-group --home-dir /home/agent --create-home --shell /usr/sbin/nologin agent \
 && rm -f /usr/bin/su
USER 10001:10001
ENV HOME=/home/agent
WORKDIR /workspace
# Run `kiro-cli acp` through `docker exec`. The container itself only idles.
ENTRYPOINT ["sleep", "infinity"]

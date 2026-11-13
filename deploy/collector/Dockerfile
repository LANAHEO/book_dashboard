# 순위 수집기 이미지(EKS 파드). 화면 서버 이미지(루트 Dockerfile)와 따로 둔다.
# 빌드는 리포 루트를 컨텍스트로 한다:
#   docker build -f deploy/collector/Dockerfile -t book-collector .
FROM node:22-slim

WORKDIR /app

# 외부 의존성이 없지만 나중에 생겨도 그대로 돌도록 남겨 둔다.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./server.js
COPY scripts ./scripts
# 스냅샷을 만들 때 화면 자산 버전을 읽는다(server.js getAssetVersion).
COPY public ./public

# server.js 는 .cache/rankings 에 파일 캐시를 남긴다. root 가 아닌 node 사용자로
# 돌리므로 그 자리를 미리 넘겨준다. 파드에서는 emptyDir 이 이 자리를 덮는다.
RUN mkdir -p /app/.cache && chown -R node:node /app/.cache

ENV NODE_ENV=production \
    COLLECT_ALIVE_FILE=/tmp/collector-alive

USER node

# 마감 없이 5분마다 돈다. 프로세스가 죽으면 k8s 가 다시 띄운다.
CMD ["node", "scripts/collector.js", "--forever"]

# Public, read-only deploy of the timeaudit viewer (Cloud Run — see DEPLOY.md).
#
# Serves already-generated chronology reports out of Firestore. It never runs
# the extraction pipeline (no live Wikipedia/academic-source fetches, no
# writes) — that stays on the private/LAN instance. See serve.js's PUBLIC flag.
FROM node:22-slim

WORKDIR /app

# Install deps first so this layer is cached across code-only rebuilds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App code. .dockerignore keeps node_modules/, .env, source-cache/, .git/, and
# generated *.html out of the image — none of it is needed (or safe) here.
COPY . .

ENV TIMEAUDIT_PUBLIC=1
ENV TIMEAUDIT_SOURCE=firestore
# Cloud Run sets PORT itself at runtime; serve.js reads process.env.PORT.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "serve.js"]

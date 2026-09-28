# The Juno API (server/). Built from the repo root because the server imports
# the generated ABIs and addresses from ../config.
FROM node:22-bookworm-slim
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm install --no-audit --no-fund
COPY config ./config
COPY server ./server
RUN cd server && npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "cd server && PORT=${PORT:-3000} npm start"]

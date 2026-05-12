# Build context must be the repo root (so ../backend is available for the go.mod replace directive).
FROM golang:1.25-alpine AS build
ARG SERVICE
WORKDIR /workspace
COPY backend /workspace/backend
COPY test_services /workspace/test_services
WORKDIR /workspace/test_services
RUN go mod download
RUN CGO_ENABLED=0 go build -o /out/svc ./${SERVICE}

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/svc /usr/local/bin/svc
ENTRYPOINT ["/usr/local/bin/svc"]

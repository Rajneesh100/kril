FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/kril ./cmd/kril

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/kril /usr/local/bin/kril
EXPOSE 8080 50051
ENTRYPOINT ["/usr/local/bin/kril"]

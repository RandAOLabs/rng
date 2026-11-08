# -------- builder --------
FROM golang:1.24 AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY app ./app

# tidy inside container so go.sum is guaranteed up to date
RUN go mod tidy

RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/whisper-node ./app

# -------- runtime --------
FROM debian:bookworm-slim

WORKDIR /app

COPY --from=builder /out/whisper-node ./whisper-node

# optional but nice
RUN chmod +x ./whisper-node

CMD ["./whisper-node"]

# ShopOrder の API（Go）のイメージ。標準ライブラリと少数の依存だけなので、CGo なしで静的にビルドして distroless に置く（シェルも curl も無い）。
# ビルドの文脈は backend/（docker-compose.yml が指す）。依存は go.sum で固定し、go mod verify で内容を確かめてからビルドする。
FROM golang:1.26.10 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY *.go ./
COPY migrations ./migrations
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /api .

FROM gcr.io/distroless/static-debian12
COPY --from=build /api /api
# root 以外で実行する（旧 Python のイメージと同じ uid）
USER 10001:10001
EXPOSE 8000
# 引数なしは API の起動。道具は `/api migrate`・`/api seed`・`/api worker`・`/api analytics-build`（docker-compose.yml の tools と worker）
ENTRYPOINT ["/api"]

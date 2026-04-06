name: Build and Publish Docker Image

on:
  push:
    branches: ["main", "release"] # This triggers the build when you push to main or release

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write # This allows GitHub to save the image to your profile

    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and Push Image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./Dockerfile
          push: true
          # This automatically tags it as ghcr.io/markld95/auto-pixai:latest
          tags: ghcr.io/${{ github.repository }}:latest
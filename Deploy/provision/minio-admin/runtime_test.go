package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"testing"
	"time"

	minio "github.com/minio/minio-go/v7"
)

// The deployment fixture supplies a disposable real TLS MinIO and protected credentials.
func TestCommunityRuntime(t *testing.T) {
	file := os.Getenv("HELM_MINIO_TEST_INPUT")
	if file == "" {
		t.Skip("isolated MinIO runtime fixture required")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal("fixture input unavailable")
	}
	var input request
	if json.Unmarshal(data, &input) != nil {
		t.Fatal("fixture input invalid")
	}
	s, err := newStorage(input)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := s.apply(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.verify(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.apply(ctx); err != nil {
		t.Fatal("idempotent provisioning failed")
	}
	payload := bytes.Repeat([]byte("community-minio-runtime\n"), 400000)
	key := "u/fixture/multipart"
	_, err = s.api.PutObject(ctx, "hg-artifacts", key, bytes.NewReader(payload), int64(len(payload)),
		minio.PutObjectOptions{ContentType: "application/octet-stream", PartSize: 5 * 1024 * 1024})
	if err != nil {
		t.Fatal("multipart PUT failed")
	}
	info, err := s.api.StatObject(ctx, "hg-artifacts", key, minio.StatObjectOptions{})
	if err != nil || info.Size != int64(len(payload)) {
		t.Fatal("HEAD size mismatch")
	}
	opts := minio.GetObjectOptions{}
	if err := opts.SetRange(17, 1023); err != nil {
		t.Fatal(err)
	}
	object, err := s.api.GetObject(ctx, "hg-artifacts", key, opts)
	if err != nil {
		t.Fatal("GET failed")
	}
	body, readErr := io.ReadAll(object)
	closeErr := object.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(body, payload[17:1024]) {
		t.Fatal("Range content mismatch")
	}
	if s.api.RemoveObject(ctx, "hg-artifacts", key, minio.RemoveObjectOptions{}) != nil {
		t.Fatal("owned object deletion failed")
	}
	if _, err := s.api.PutObject(ctx, "hg-artifacts", "outside-prefix", bytes.NewReader([]byte("denied")), 6,
		minio.PutObjectOptions{}); minio.ToErrorResponse(err).Code != "AccessDenied" {
		t.Fatal("object scope must reject writes outside u/")
	}
	ledger := "control/deletions/fixture"
	if _, err := s.api.PutObject(ctx, "hg-staging", ledger, bytes.NewReader([]byte("fixture")), 7,
		minio.PutObjectOptions{}); err != nil {
		t.Fatal("ledger publication failed")
	}
	if err := s.api.RemoveObject(ctx, "hg-staging", ledger, minio.RemoveObjectOptions{}); minio.ToErrorResponse(err).Code != "AccessDenied" {
		t.Fatal("service identity must not delete the independent ledger")
	}
}

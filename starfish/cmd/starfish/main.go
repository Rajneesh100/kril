package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/rajneesh/starfish/pkg/analytics"
	"github.com/rajneesh/starfish/pkg/config"
	"github.com/rajneesh/starfish/pkg/storage/elastic"
	"github.com/rajneesh/starfish/pkg/telemetry"
	"google.golang.org/grpc"
)

func main() {
	configPath := ""
	if len(os.Args) > 1 {
		configPath = os.Args[1]
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	// Init Elasticsearch (stores both service_logs and telemetry_logs)
	esClient, err := elastic.New(cfg.ElasticURL, cfg.ElasticIndex)
	if err != nil {
		log.Fatalf("failed to create ES client: %v", err)
	}
	if err := esClient.EnsureIndices(context.Background()); err != nil {
		log.Printf("WARN: could not ensure ES indices (will retry on write): %v", err)
	}

	// Start gRPC server
	grpcLis, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.GRPCPort))
	if err != nil {
		log.Fatalf("failed to listen on gRPC port %d: %v", cfg.GRPCPort, err)
	}

	grpcServer := grpc.NewServer()
	telemetrySvc := telemetry.NewService(esClient)
	telemetrySvc.Register(grpcServer)

	go func() {
		log.Printf("starfish gRPC server listening on :%d", cfg.GRPCPort)
		if err := grpcServer.Serve(grpcLis); err != nil {
			log.Fatalf("gRPC server error: %v", err)
		}
	}()

	// Start HTTP server (analytics APIs)
	router := analytics.NewRouter(esClient)
	httpServer := &http.Server{
		Addr:    fmt.Sprintf(":%d", cfg.HTTPPort),
		Handler: router,
	}

	go func() {
		log.Printf("starfish HTTP server listening on :%d", cfg.HTTPPort)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("shutting down starfish...")
	grpcServer.GracefulStop()
	httpServer.Close()
}

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

	"github.com/Rajneesh100/kril/backend/pkg/analytics"
	"github.com/Rajneesh100/kril/backend/pkg/config"
	"github.com/Rajneesh100/kril/backend/pkg/storage/elastic"
	"github.com/Rajneesh100/kril/backend/pkg/storage/victoria"
	"github.com/Rajneesh100/kril/backend/pkg/telemetry"
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

	// Init VictoriaMetrics (time-series metrics for analytics)
	vmClient, err := victoria.New(cfg.VictoriaURL)
	if err != nil {
		log.Printf("WARN: could not create VM client: %v", err)
	} else {
		log.Printf("VictoriaMetrics client connected to %s", cfg.VictoriaURL)
	}

	// Start gRPC server
	grpcLis, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.GRPCPort))
	if err != nil {
		log.Fatalf("failed to listen on gRPC port %d: %v", cfg.GRPCPort, err)
	}

	grpcServer := grpc.NewServer()
	telemetrySvc := telemetry.NewService(esClient, vmClient)
	telemetrySvc.Register(grpcServer)

	go func() {
		log.Printf("kril gRPC server listening on :%d", cfg.GRPCPort)
		if err := grpcServer.Serve(grpcLis); err != nil {
			log.Fatalf("gRPC server error: %v", err)
		}
	}()

	// Start HTTP server (analytics APIs)
	router := analytics.NewRouter(esClient, vmClient)
	httpServer := &http.Server{
		Addr:    fmt.Sprintf(":%d", cfg.HTTPPort),
		Handler: router,
	}

	go func() {
		log.Printf("kril HTTP server listening on :%d", cfg.HTTPPort)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("shutting down kril...")
	grpcServer.GracefulStop()
	httpServer.Close()
}

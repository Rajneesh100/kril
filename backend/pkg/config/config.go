package config

import (
	"encoding/json"
	"os"
	"strconv"
)

type Config struct {
	GRPCPort     int    `json:"grpc_port"`
	HTTPPort     int    `json:"http_port"`
	ElasticURL   string `json:"elastic_url"`
	ElasticIndex string `json:"elastic_index"`
	VictoriaURL  string `json:"victoria_url"`
}

func Default() *Config {
	return &Config{
		GRPCPort:     50051,
		HTTPPort:     8080,
		ElasticURL:   "http://localhost:9200",
		ElasticIndex: "service_logs",
		VictoriaURL:  "http://localhost:8428",
	}
}

func Load(path string) (*Config, error) {
	cfg := Default()

	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		if data != nil {
			if err := json.Unmarshal(data, cfg); err != nil {
				return nil, err
			}
		}
	}

	// Env overrides
	if v := os.Getenv("KRIL_GRPC_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil {
			cfg.GRPCPort = p
		}
	}
	if v := os.Getenv("KRIL_HTTP_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil {
			cfg.HTTPPort = p
		}
	}
	if v := os.Getenv("KRIL_ELASTIC_URL"); v != "" {
		cfg.ElasticURL = v
	}
	if v := os.Getenv("KRIL_VICTORIA_URL"); v != "" {
		cfg.VictoriaURL = v
	}

	return cfg, nil
}

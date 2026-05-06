// Service C: inventory and billing service.
// Endpoints:
//   GET /api1 - check inventory (local DB)
//   GET /api2 - get billing info (local DB + external payment API)
//   GET /api3 - sync inventory (calls service_a /api3 for health, then updates DB)

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"time"

	sctx "github.com/rajneesh/starfish/pkg/ctx"
)

var serviceAURL string

func main() {
	starfishAddr := envOr("STARFISH_GRPC_ADDR", "localhost:50051")
	serviceAURL = envOr("SERVICE_A_URL", "http://localhost:8081")
	port := envOr("PORT", "8083")

	sctx.Configure("service_c", starfishAddr)

	http.HandleFunc("/api1", handleAPI1)
	http.HandleFunc("/api2", handleAPI2)
	http.HandleFunc("/api3", handleAPI3)

	log.Printf("service_c listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// api1: Check inventory
func handleAPI1(w http.ResponseWriter, r *http.Request) {
	sc := sctx.New(r.Context(), sctx.WithProcessType("api"), sctx.WithEndpoint("/api1"))
	defer sc.Finish()

	_, _ = sc.Trace("CheckInventory", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall("database")
		tc.LogInfo("querying inventory table")
		simulateWork(8, 20)
		inventory := []map[string]any{
			{"sku": "WA-001", "qty": 150, "warehouse": "US-EAST"},
			{"sku": "WB-002", "qty": 30, "warehouse": "US-WEST"},
		}
		tc.SetOutput(inventory)
		return inventory, nil
	})

	// Cache result
	_, _ = sc.TraceChild("CacheResult", "CheckInventory", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall("database") // Redis cache
		tc.LogInfo("caching inventory result for 60s")
		simulateWork(1, 3)
		return true, nil
	})

	writeJSON(w, map[string]string{"status": "ok", "service": "c", "endpoint": "api1"})
}

// api2: Get billing info
func handleAPI2(w http.ResponseWriter, r *http.Request) {
	sc := sctx.New(r.Context(), sctx.WithProcessType("api"), sctx.WithEndpoint("/api2"))
	defer sc.Finish()

	// Fetch billing records
	_, _ = sc.Trace("FetchBillingRecords", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall("database")
		tc.LogInfo("querying billing_records table")
		simulateWork(12, 35)
		if rand.Float64() < 0.04 {
			tc.LogError("billing records query timeout")
			return nil, fmt.Errorf("query timeout")
		}
		return map[string]any{"total_billed": 1250.00, "outstanding": 150.00}, nil
	})

	// Verify with payment provider
	_, _ = sc.TraceChild("VerifyPaymentStatus", "FetchBillingRecords", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall("https://api.stripe.com/v1/charges")
		tc.LogInfo("verifying payment status with Stripe")
		simulateWork(50, 150) // External API call is slow
		if rand.Float64() < 0.06 {
			tc.LogError("Stripe API rate limited")
			return nil, fmt.Errorf("rate limited")
		}
		tc.LogInfo("payment verification complete")
		return map[string]string{"status": "verified"}, nil
	})

	writeJSON(w, map[string]string{"status": "ok", "service": "c", "endpoint": "api2"})
}

// api3: Sync inventory (calls service_a for health check first)
func handleAPI3(w http.ResponseWriter, r *http.Request) {
	sc := sctx.New(r.Context(), sctx.WithProcessType("api"), sctx.WithEndpoint("/api3"))
	defer sc.Finish()

	// Check service_a health
	_, _ = sc.Trace("CheckUpstreamHealth", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall(serviceAURL + "/api3")
		tc.LogInfo("checking service_a health")
		resp, err := http.Get(serviceAURL + "/api3")
		if err != nil {
			tc.LogError("service_a health check failed: %s", err)
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return json.RawMessage(body), nil
	})

	// Perform inventory sync
	_, _ = sc.TraceChild("SyncInventoryDB", "CheckUpstreamHealth", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall("database")
		tc.LogInfo("syncing inventory records")
		simulateWork(20, 60)
		if rand.Float64() < 0.1 { // 10% sync failure
			tc.LogError("inventory sync failed: deadlock detected")
			return nil, fmt.Errorf("deadlock")
		}
		tc.LogInfo("synced 42 records")
		return map[string]int{"synced": 42}, nil
	})

	writeJSON(w, map[string]string{"status": "ok", "service": "c", "endpoint": "api3"})
}

func writeJSON(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func simulateWork(minMs, maxMs int) {
	time.Sleep(time.Duration(minMs+rand.Intn(maxMs-minMs)) * time.Millisecond)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

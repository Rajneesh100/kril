// Service A: user-facing API service.
// Endpoints:
//   GET /api1 - get user profile (calls service_b /api1 for account data)
//   GET /api2 - list orders (calls service_b /api2 + service_c /api1 in parallel)
//   GET /api3 - health check

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

var (
	serviceBURL string
	serviceCURL string
)

func main() {
	starfishAddr := envOr("STARFISH_GRPC_ADDR", "localhost:50051")
	serviceBURL = envOr("SERVICE_B_URL", "http://localhost:8082")
	serviceCURL = envOr("SERVICE_C_URL", "http://localhost:8083")
	port := envOr("PORT", "8081")

	sctx.Configure("service_a", starfishAddr)

	http.HandleFunc("/api1", handleAPI1)
	http.HandleFunc("/api2", handleAPI2)
	http.HandleFunc("/api3", handleAPI3)

	log.Printf("service_a listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// api1: Get user profile
func handleAPI1(w http.ResponseWriter, r *http.Request) {
	sc := sctx.New(r.Context(), sctx.WithProcessType("api"), sctx.WithEndpoint("/api1"))
	defer sc.Finish()

	// Step 1: validate request
	_, _ = sc.Trace("ValidateRequest", func(tc *sctx.TraceCtx) (any, error) {
		tc.SetInput(map[string]string{"path": r.URL.Path})
		tc.LogInfo("validating request headers")
		simulateWork(5, 15)
		tc.SetOutput(map[string]bool{"valid": true})
		return true, nil
	})

	// Step 2: get user from local DB
	userData, _ := sc.TraceChild("GetUserFromDB", "ValidateRequest", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall("database")
		tc.LogInfo("querying users table")
		simulateWork(10, 30)
		if rand.Float64() < 0.05 { // 5% chance of DB error
			tc.LogError("connection timeout to users table")
			return nil, fmt.Errorf("db connection timeout")
		}
		result := map[string]any{"user_id": 123, "name": "John Doe", "email": "john@example.com"}
		tc.SetOutput(result)
		return result, nil
	})

	// Step 3: call service_b for account data
	_, _ = sc.TraceChild("FetchAccountData", "GetUserFromDB", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall(serviceBURL + "/api1")
		tc.LogInfo("calling service_b for account data")
		resp, err := http.Get(serviceBURL + "/api1")
		if err != nil {
			tc.LogError("service_b call failed: %s", err)
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		tc.SetOutput(json.RawMessage(body))
		return json.RawMessage(body), nil
	})

	writeJSON(w, map[string]any{"status": "ok", "user": userData})
}

// api2: List orders (parallel calls to service_b and service_c)
func handleAPI2(w http.ResponseWriter, r *http.Request) {
	sc := sctx.New(r.Context(), sctx.WithProcessType("api"), sctx.WithEndpoint("/api2"))
	defer sc.Finish()

	// Step 1: authenticate
	_, _ = sc.Trace("Authenticate", func(tc *sctx.TraceCtx) (any, error) {
		tc.LogInfo("checking auth token")
		simulateWork(3, 8)
		if rand.Float64() < 0.02 { // 2% auth failure
			tc.LogError("invalid auth token")
			return nil, fmt.Errorf("unauthorized")
		}
		return true, nil
	})

	// Step 2: parallel calls to service_b and service_c
	results := sc.TraceParallel("Authenticate", map[string]func(tc *sctx.TraceCtx) (any, error){
		"FetchOrders": func(tc *sctx.TraceCtx) (any, error) {
			tc.RecordExternalCall(serviceBURL + "/api2")
			tc.LogInfo("fetching orders from service_b")
			resp, err := http.Get(serviceBURL + "/api2")
			if err != nil {
				tc.LogError("service_b /api2 failed: %s", err)
				return nil, err
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			return json.RawMessage(body), nil
		},
		"FetchInventory": func(tc *sctx.TraceCtx) (any, error) {
			tc.RecordExternalCall(serviceCURL + "/api1")
			tc.LogInfo("fetching inventory from service_c")
			resp, err := http.Get(serviceCURL + "/api1")
			if err != nil {
				tc.LogError("service_c /api1 failed: %s", err)
				return nil, err
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			return json.RawMessage(body), nil
		},
	})

	// Step 3: merge results
	_, _ = sc.TraceChild("MergeResults", "FetchOrders", func(tc *sctx.TraceCtx) (any, error) {
		tc.LogInfo("merging order and inventory data")
		simulateWork(2, 5)
		return results, nil
	})

	writeJSON(w, map[string]any{"status": "ok", "data": results})
}

// api3: Health check
func handleAPI3(w http.ResponseWriter, r *http.Request) {
	sc := sctx.New(r.Context(), sctx.WithProcessType("api"), sctx.WithEndpoint("/api3"))
	defer sc.Finish()

	sc.Trace("HealthCheck", func(tc *sctx.TraceCtx) (any, error) {
		tc.LogInfo("all systems operational")
		return "ok", nil
	})

	writeJSON(w, map[string]string{"status": "healthy"})
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

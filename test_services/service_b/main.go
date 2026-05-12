// Service B: account and order service.
// Endpoints:
//   GET /api1 - get account details (calls service_c /api2 for billing)
//   GET /api2 - list orders (local DB query)
//   GET /api3 - update order status (calls service_c /api1)

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

	sctx "github.com/Rajneesh100/kril/backend/pkg/ctx"
)

var serviceCURL string

func main() {
	krilAddr := envOr("KRIL_GRPC_ADDR", "localhost:50051")
	serviceCURL = envOr("SERVICE_C_URL", "http://localhost:8083")
	port := envOr("PORT", "8082")

	sctx.Configure("service_b", krilAddr)

	http.HandleFunc("/api1", handleAPI1)
	http.HandleFunc("/api2", handleAPI2)
	http.HandleFunc("/api3", handleAPI3)

	log.Printf("service_b listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// api1: Get account details
func handleAPI1(w http.ResponseWriter, r *http.Request) {
	sc := sctx.New(r.Context(), sctx.WithProcessType("api"), sctx.WithEndpoint("/api1"))
	defer sc.Finish()

	// Fetch account from DB
	_, _ = sc.Trace("FetchAccount", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall("database")
		tc.LogInfo("querying accounts table")
		simulateWork(8, 25)
		if rand.Float64() < 0.03 {
			tc.LogError("accounts table lock timeout")
			return nil, fmt.Errorf("lock timeout")
		}
		return map[string]any{"account_id": 456, "plan": "pro", "balance": 99.50}, nil
	})

	// Call service_c for billing info
	_, _ = sc.TraceChild("GetBillingInfo", "FetchAccount", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall(serviceCURL + "/api2")
		tc.LogInfo("fetching billing from service_c")
		resp, err := http.Get(serviceCURL + "/api2")
		if err != nil {
			tc.LogError("service_c /api2 failed: %s", err)
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return json.RawMessage(body), nil
	})

	writeJSON(w, map[string]string{"status": "ok", "service": "b", "endpoint": "api1"})
}

// api2: List orders
func handleAPI2(w http.ResponseWriter, r *http.Request) {
	sc := sctx.New(r.Context(), sctx.WithProcessType("api"), sctx.WithEndpoint("/api2"))
	defer sc.Finish()

	// Query orders
	_, _ = sc.Trace("QueryOrders", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall("database")
		tc.LogInfo("querying orders table with pagination")
		simulateWork(15, 50)
		orders := []map[string]any{
			{"order_id": 1001, "item": "Widget A", "qty": 3},
			{"order_id": 1002, "item": "Widget B", "qty": 1},
		}
		tc.SetOutput(orders)
		return orders, nil
	})

	// Compute totals
	_, _ = sc.TraceChild("ComputeTotals", "QueryOrders", func(tc *sctx.TraceCtx) (any, error) {
		tc.LogInfo("computing order totals")
		simulateWork(2, 5)
		if rand.Float64() < 0.08 { // 8% chance of calculation error
			tc.LogError("overflow in total calculation")
			return nil, fmt.Errorf("arithmetic overflow")
		}
		return map[string]float64{"total": 150.00, "tax": 12.50}, nil
	})

	writeJSON(w, map[string]string{"status": "ok", "service": "b", "endpoint": "api2"})
}

// api3: Update order status
func handleAPI3(w http.ResponseWriter, r *http.Request) {
	sc := sctx.New(r.Context(), sctx.WithProcessType("api"), sctx.WithEndpoint("/api3"))
	defer sc.Finish()

	// Validate order
	_, _ = sc.Trace("ValidateOrder", func(tc *sctx.TraceCtx) (any, error) {
		tc.LogInfo("validating order exists")
		tc.RecordExternalCall("database")
		simulateWork(5, 10)
		return true, nil
	})

	// Update DB
	_, _ = sc.TraceChild("UpdateOrderStatus", "ValidateOrder", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall("database")
		tc.LogInfo("updating order status to 'shipped'")
		simulateWork(10, 20)
		return true, nil
	})

	// Notify inventory service
	_, _ = sc.TraceChild("NotifyInventory", "UpdateOrderStatus", func(tc *sctx.TraceCtx) (any, error) {
		tc.RecordExternalCall(serviceCURL + "/api1")
		tc.LogInfo("notifying service_c about shipment")
		resp, err := http.Get(serviceCURL + "/api1")
		if err != nil {
			tc.LogError("service_c notification failed: %s", err)
			return nil, err
		}
		defer resp.Body.Close()
		return "notified", nil
	})

	writeJSON(w, map[string]string{"status": "ok", "service": "b", "endpoint": "api3"})
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

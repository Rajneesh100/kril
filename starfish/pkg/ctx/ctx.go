// Package ctx provides a custom context wrapper that tracks function execution
// for observability. It preserves all standard context.Context behavior while
// adding telemetry collection that gets pushed to starfish via gRPC.
//
// Usage:
//
//	func HandleAPI(w http.ResponseWriter, r *http.Request) {
//	    sctx := ctx.New(r.Context(), ctx.WithProcessType("api"), ctx.WithEndpoint("/users"))
//	    defer sctx.Finish()
//
//	    result, err := sctx.Trace("GetUser", func(tc *ctx.TraceCtx) (any, error) {
//	        tc.LogInfo("fetching user from db")
//	        return db.GetUser(tc.Context(), userID)
//	    })
//	}
package ctx

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/rajneesh/starfish/pkg/telemetry/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// --- Package-level config ---

var (
	globalServiceName string
	globalGRPCAddr    string
	globalConn        *grpc.ClientConn
	globalClient      pb.TelemetryServiceClient
	globalMu          sync.Mutex
)

// Configure sets the service name and starfish gRPC address.
// Call this once at startup (e.g., in config.go or main.go).
func Configure(serviceName, grpcAddr string) {
	globalMu.Lock()
	defer globalMu.Unlock()
	globalServiceName = serviceName
	globalGRPCAddr = grpcAddr
}

func getClient() pb.TelemetryServiceClient {
	globalMu.Lock()
	defer globalMu.Unlock()

	if globalClient != nil {
		return globalClient
	}
	if globalGRPCAddr == "" {
		return nil
	}

	conn, err := grpc.NewClient(globalGRPCAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Printf("starfish ctx: failed to connect to %s: %v", globalGRPCAddr, err)
		return nil
	}
	globalConn = conn
	globalClient = pb.NewTelemetryServiceClient(conn)
	return globalClient
}

// --- StarfishCtx: the main context wrapper ---

type StarfishCtx struct {
	context.Context
	mu           sync.Mutex
	processType  string
	endpoint     string
	isSuccessful bool
	startTime    time.Time
	traces       []*functionTrace
	indexCounter atomic.Int32
}

type functionTrace struct {
	index           int32
	currentFunction string
	parentFunction  string
	input           string
	output          string
	latencyMs       float64
	haveError       bool
	logs            []logEntry
	externalCalls   []string
	startTime       time.Time
}

type logEntry struct {
	timestamp time.Time
	level     string
	message   string
}

// Options for creating a new StarfishCtx.
type Option func(*StarfishCtx)

func WithProcessType(pt string) Option { return func(s *StarfishCtx) { s.processType = pt } }
func WithEndpoint(ep string) Option    { return func(s *StarfishCtx) { s.endpoint = ep } }

// New creates a new StarfishCtx wrapping the given context.
func New(parent context.Context, opts ...Option) *StarfishCtx {
	sc := &StarfishCtx{
		Context:      parent,
		isSuccessful: true,
		startTime:    time.Now(),
	}
	for _, o := range opts {
		o(sc)
	}
	return sc
}

// TraceCtx is passed to traced functions so they can log and record metadata.
type TraceCtx struct {
	context.Context
	sc    *StarfishCtx
	trace *functionTrace
}

// LogInfo records an info-level log.
func (tc *TraceCtx) LogInfo(msg string, args ...any) {
	tc.addLog("info", fmt.Sprintf(msg, args...))
}

// LogError records an error-level log and marks the function as having an error.
func (tc *TraceCtx) LogError(msg string, args ...any) {
	tc.trace.haveError = true
	tc.addLog("error", fmt.Sprintf(msg, args...))
}

// LogWarn records a warn-level log.
func (tc *TraceCtx) LogWarn(msg string, args ...any) {
	tc.addLog("warn", fmt.Sprintf(msg, args...))
}

// LogDebug records a debug-level log.
func (tc *TraceCtx) LogDebug(msg string, args ...any) {
	tc.addLog("debug", fmt.Sprintf(msg, args...))
}

// RecordExternalCall records an outgoing HTTP/gRPC/DB call.
func (tc *TraceCtx) RecordExternalCall(url string) {
	tc.trace.externalCalls = append(tc.trace.externalCalls, url)
}

// SetInput records the function's input (will be JSON-serialized).
func (tc *TraceCtx) SetInput(v any) {
	if data, err := json.Marshal(v); err == nil {
		tc.trace.input = string(data)
	}
}

// SetOutput records the function's output (will be JSON-serialized).
func (tc *TraceCtx) SetOutput(v any) {
	if data, err := json.Marshal(v); err == nil {
		tc.trace.output = string(data)
	}
}

func (tc *TraceCtx) addLog(level, msg string) {
	tc.trace.logs = append(tc.trace.logs, logEntry{
		timestamp: time.Now(),
		level:     level,
		message:   msg,
	})
}

// Trace executes fn and records its execution trace. The function name
// is auto-detected from the caller if name is empty.
func (sc *StarfishCtx) Trace(name string, fn func(tc *TraceCtx) (any, error)) (any, error) {
	return sc.traceWithParent(name, "", fn)
}

// TraceChild is like Trace but explicitly sets the parent function name.
func (sc *StarfishCtx) TraceChild(name, parentName string, fn func(tc *TraceCtx) (any, error)) (any, error) {
	return sc.traceWithParent(name, parentName, fn)
}

func (sc *StarfishCtx) traceWithParent(name, parentName string, fn func(tc *TraceCtx) (any, error)) (any, error) {
	if name == "" {
		name = callerName(2)
	}

	idx := sc.indexCounter.Add(1) - 1

	ft := &functionTrace{
		index:           idx,
		currentFunction: name,
		parentFunction:  parentName,
		startTime:       time.Now(),
	}

	tc := &TraceCtx{
		Context: sc.Context,
		sc:      sc,
		trace:   ft,
	}

	result, err := fn(tc)

	ft.latencyMs = float64(time.Since(ft.startTime).Microseconds()) / 1000.0

	if err != nil {
		ft.haveError = true
		tc.addLog("error", err.Error())
		sc.isSuccessful = false
	}

	sc.mu.Lock()
	sc.traces = append(sc.traces, ft)
	sc.mu.Unlock()

	return result, err
}

// TraceParallel executes multiple functions in parallel with the same index
// (as specified in goal.md for parallel calls).
func (sc *StarfishCtx) TraceParallel(parentName string, fns map[string]func(tc *TraceCtx) (any, error)) map[string]any {
	idx := sc.indexCounter.Add(1) - 1

	var mu sync.Mutex
	results := map[string]any{}
	var wg sync.WaitGroup

	for name, fn := range fns {
		wg.Add(1)
		go func(n string, f func(tc *TraceCtx) (any, error)) {
			defer wg.Done()

			ft := &functionTrace{
				index:           idx, // same index for parallel calls
				currentFunction: n,
				parentFunction:  parentName,
				startTime:       time.Now(),
			}
			tc := &TraceCtx{Context: sc.Context, sc: sc, trace: ft}

			result, err := f(tc)
			ft.latencyMs = float64(time.Since(ft.startTime).Microseconds()) / 1000.0

			if err != nil {
				ft.haveError = true
				tc.addLog("error", err.Error())
				sc.isSuccessful = false
			}

			sc.mu.Lock()
			sc.traces = append(sc.traces, ft)
			sc.mu.Unlock()

			mu.Lock()
			results[n] = result
			mu.Unlock()
		}(name, fn)
	}

	wg.Wait()
	return results
}

// MarkFailed explicitly marks the overall process as failed.
func (sc *StarfishCtx) MarkFailed() {
	sc.isSuccessful = false
}

// Finish completes the context and asynchronously pushes telemetry to starfish.
// Always call this via defer.
func (sc *StarfishCtx) Finish() {
	totalLatency := float64(time.Since(sc.startTime).Microseconds()) / 1000.0

	client := getClient()
	if client == nil {
		return
	}

	req := &pb.PushMetricRequest{
		ServiceName:  globalServiceName,
		ProcessType:  sc.processType,
		Endpoint:     sc.endpoint,
		Timestamp:    sc.startTime.UTC().Format(time.RFC3339),
		IsSuccessful: sc.isSuccessful,
		LatencyMs:    totalLatency,
	}

	sc.mu.Lock()
	for _, ft := range sc.traces {
		trace := &pb.FunctionTrace{
			Index:           ft.index,
			CurrentFunction: ft.currentFunction,
			ParentFunction:  ft.parentFunction,
			Input:           ft.input,
			Output:          ft.output,
			LatencyMs:       ft.latencyMs,
			HaveError:       ft.haveError,
		}
		for _, l := range ft.logs {
			trace.Logs = append(trace.Logs, &pb.LogEntry{
				Timestamp: l.timestamp.UTC().Format(time.RFC3339Nano),
				Level:     l.level,
				Message:   l.message,
			})
		}
		for _, ec := range ft.externalCalls {
			trace.ExternalCalls = append(trace.ExternalCalls, &pb.ExternalCall{Url: ec})
		}
		req.ExecutionFlow = append(req.ExecutionFlow, trace)
	}
	sc.mu.Unlock()

	// Fire and forget
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := client.PushMetric(bgCtx, req); err != nil {
			log.Printf("starfish ctx: push metric failed: %v", err)
		}
	}()
}

func callerName(skip int) string {
	pc, _, _, ok := runtime.Caller(skip + 1)
	if !ok {
		return "unknown"
	}
	fn := runtime.FuncForPC(pc)
	if fn == nil {
		return "unknown"
	}
	name := fn.Name()
	// Extract just the function name from the full path
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	return name
}

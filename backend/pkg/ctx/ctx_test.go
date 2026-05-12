package ctx

import (
	"context"
	"errors"
	"testing"
)

func TestNewCtxPreservesParentContext(t *testing.T) {
	type key struct{}
	parent := context.WithValue(context.Background(), key{}, "hello")
	sc := New(parent, WithProcessType("api"), WithEndpoint("/test"))

	if v, ok := sc.Value(key{}).(string); !ok || v != "hello" {
		t.Fatal("KrilCtx must preserve parent context values")
	}
}

func TestTraceRecordsExecution(t *testing.T) {
	sc := New(context.Background(), WithProcessType("api"), WithEndpoint("/test"))

	result, err := sc.Trace("myFunc", func(tc *TraceCtx) (any, error) {
		tc.SetInput(map[string]string{"key": "val"})
		tc.LogInfo("doing work")
		tc.SetOutput(map[string]int{"count": 42})
		return 42, nil
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != 42 {
		t.Fatalf("expected 42, got %v", result)
	}
	if len(sc.traces) != 1 {
		t.Fatalf("expected 1 trace, got %d", len(sc.traces))
	}

	ft := sc.traces[0]
	if ft.currentFunction != "myFunc" {
		t.Errorf("expected function name 'myFunc', got '%s'", ft.currentFunction)
	}
	if ft.haveError {
		t.Error("expected no error")
	}
	if ft.latencyMs <= 0 {
		t.Error("expected positive latency")
	}
	if len(ft.logs) != 1 || ft.logs[0].level != "info" {
		t.Error("expected 1 info log")
	}
	if ft.input == "" || ft.output == "" {
		t.Error("expected input and output to be set")
	}
}

func TestTraceRecordsErrors(t *testing.T) {
	sc := New(context.Background())

	_, err := sc.Trace("failFunc", func(tc *TraceCtx) (any, error) {
		tc.LogError("something went wrong")
		return nil, errors.New("boom")
	})

	if err == nil {
		t.Fatal("expected error")
	}
	if sc.isSuccessful {
		t.Error("expected isSuccessful to be false after error")
	}
	if !sc.traces[0].haveError {
		t.Error("expected haveError to be true")
	}
}

func TestTraceChildSetsParent(t *testing.T) {
	sc := New(context.Background())

	sc.TraceChild("child", "parent", func(tc *TraceCtx) (any, error) {
		return nil, nil
	})

	if sc.traces[0].parentFunction != "parent" {
		t.Errorf("expected parent 'parent', got '%s'", sc.traces[0].parentFunction)
	}
}

func TestTraceParallel(t *testing.T) {
	sc := New(context.Background())

	results := sc.TraceParallel("handler", map[string]func(tc *TraceCtx) (any, error){
		"funcA": func(tc *TraceCtx) (any, error) {
			tc.LogInfo("a")
			return "a", nil
		},
		"funcB": func(tc *TraceCtx) (any, error) {
			tc.LogInfo("b")
			return "b", nil
		},
	})

	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if len(sc.traces) != 2 {
		t.Fatalf("expected 2 traces, got %d", len(sc.traces))
	}

	// Parallel calls should share the same index
	idx := sc.traces[0].index
	for _, ft := range sc.traces {
		if ft.index != idx {
			t.Error("parallel traces should share the same index")
		}
		if ft.parentFunction != "handler" {
			t.Errorf("expected parent 'handler', got '%s'", ft.parentFunction)
		}
	}
}

func TestExternalCalls(t *testing.T) {
	sc := New(context.Background())

	sc.Trace("apiCaller", func(tc *TraceCtx) (any, error) {
		tc.RecordExternalCall("https://service-b.internal/api/data")
		tc.RecordExternalCall("database")
		return nil, nil
	})

	ft := sc.traces[0]
	if len(ft.externalCalls) != 2 {
		t.Fatalf("expected 2 external calls, got %d", len(ft.externalCalls))
	}
}

func TestMarkFailed(t *testing.T) {
	sc := New(context.Background())
	sc.MarkFailed()
	if sc.isSuccessful {
		t.Error("expected isSuccessful to be false after MarkFailed")
	}
}

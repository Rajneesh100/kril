#!/bin/bash
# Load generator: hits test service APIs to generate telemetry data.
# Usage: ./loadgen.sh [iterations] [delay_ms]

ITERATIONS=${1:-100}
DELAY_MS=${2:-200}
SERVICE_A="http://localhost:8081"

echo "=== kril Load Generator ==="
echo "Hitting service_a endpoints for $ITERATIONS iterations (${DELAY_MS}ms delay)"
echo ""

ENDPOINTS=("/api1" "/api2" "/api3")
SUCCESS=0
FAIL=0

for i in $(seq 1 "$ITERATIONS"); do
    # Pick a random endpoint with weighted distribution
    RAND=$((RANDOM % 10))
    if [ $RAND -lt 4 ]; then
        EP="/api1"  # 40% - user profile
    elif [ $RAND -lt 8 ]; then
        EP="/api2"  # 40% - list orders
    else
        EP="/api3"  # 20% - health check
    fi

    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SERVICE_A$EP" 2>/dev/null)
    if [ "$STATUS" = "200" ]; then
        SUCCESS=$((SUCCESS + 1))
        echo "[$i/$ITERATIONS] $EP -> $STATUS"
    else
        FAIL=$((FAIL + 1))
        echo "[$i/$ITERATIONS] $EP -> $STATUS (FAIL)"
    fi

    # Delay between requests
    sleep "$(echo "scale=3; $DELAY_MS/1000" | bc)"
done

echo ""
echo "=== Summary ==="
echo "Total:   $ITERATIONS"
echo "Success: $SUCCESS"
echo "Failed:  $FAIL"

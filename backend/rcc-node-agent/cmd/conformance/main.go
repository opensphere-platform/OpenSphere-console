// Cross-language conformance: the plan the Node backend emits must parse in the
// Go agent, and the receipt the Go agent emits must validate in Node.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"opensphere.io/rcc/node-agent/internal/plan"
)

func main() {
	mode := os.Args[1]

	if mode == "parse-plan" {
		raw, err := os.ReadFile(os.Args[2])
		if err != nil {
			fmt.Println("READ_ERROR", err)
			os.Exit(1)
		}
		self := plan.Identity{ControlCenterID: os.Args[3], HostID: os.Args[4]}
		parsed, err := plan.Parse(raw, self, time.Now())
		if err != nil {
			fmt.Println("REJECTED", err)
			os.Exit(1)
		}
		fmt.Printf("ACCEPTED operation=%s attempt=%d host=%s\n",
			parsed.Operation, parsed.Attempt, parsed.HostID)
		return
	}

	if mode == "emit-receipt" {
		receipt := plan.Receipt{
			SchemaVersion:   plan.ReceiptSchemaVersion,
			OperationID:     os.Args[2],
			Attempt:         1,
			ControlCenterID: "cc2",
			HostID:          "node-a",
			Operation:       plan.OpJournalQuery,
			ContentDigest:   os.Args[3],
			Outcome:         plan.OutcomeSucceeded,
			StartedAt:       time.Now().Add(-time.Second),
			FinishedAt:      time.Now(),
			ExitCode:        0,
			Message:         "journal query completed",
			Output:          "aug 01 12:00:00 node-a chronyd[1]: ok\n",
			Evidence:        map[string]string{"lines": "1"},
		}
		if err := receipt.Validate(); err != nil {
			fmt.Println("SELF_INVALID", err)
			os.Exit(1)
		}
		out, _ := json.Marshal(receipt)
		fmt.Println(string(out))
		return
	}

	if mode == "sign-response" {
		signResponseMode(os.Args[2:])
		return
	}

	fmt.Println("unknown mode")
	os.Exit(2)
}

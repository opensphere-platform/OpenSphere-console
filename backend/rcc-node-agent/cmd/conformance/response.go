package main

import (
	"fmt"
	"os"
	"strconv"

	"opensphere.io/rcc/node-agent/internal/protocol"
)

// signResponseMode emits the response signature for a fixed binding so the Node
// implementation can be compared byte for byte.
func signResponseMode(args []string) {
	attempt, _ := strconv.Atoi(args[4])
	binding := protocol.ResponseBinding{
		KeyID:           args[0],
		ControlCenterID: args[1],
		HostID:          args[2],
		OperationID:     args[3],
		Attempt:         attempt,
		IssuedAt:        args[5],
		Nonce:           args[6],
		BodySHA256:      protocol.BodyDigest([]byte(args[7])),
	}
	signature, err := protocol.SignResponse([]byte(args[8]), binding)
	if err != nil {
		fmt.Println("ERROR", err)
		os.Exit(1)
	}
	fmt.Println(signature)
}

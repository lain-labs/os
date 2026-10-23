---
name: fuji-node
description: Check the Avalanche validator this container runs next to — health, P-Chain sync, peers, the Fuji L1's latest block and the validator's P-Chain balance — through the node's API socket.
---

# The Fuji node

This host runs the only validator of Cyberia's Fuji L1 (Subnet-EVM). Its node API
is the socket `/run/lain-node/fuji.sock` (the host's `127.0.0.1:9650`). Every call
below only reads.

| | |
|---|---|
| Node ID | `NodeID-6VfUgV34HC4b6S7wu375cDmsUG3gzcHZ7` |
| Subnet | `UVRXcqMkQM9X8Wv6BmXXEbFbAcbKoW1t8vde5Lds35SLQSVn3` |
| Blockchain | `Lm8HNjKAQ7ujA7XDphehkqbnu8wKjfzxpF1THX3HLyzoJhfv7` (EVM chain id 49407) |
| Validation ID | `2KZnTnX6QqZ1WNAFd7BCp9cKgXWYd3MXoj1zpccdSfVG14ULLJ` |

```bash
S="--unix-socket /run/lain-node/fuji.sock -s -H content-type:application/json"
rpc() { curl $S -X POST "http://node$1" --data "$2"; }

curl $S http://node/ext/health                                    # healthy: true, per check
rpc /ext/info '{"jsonrpc":"2.0","id":1,"method":"info.isBootstrapped","params":{"chain":"P"}}'
rpc /ext/info '{"jsonrpc":"2.0","id":1,"method":"info.peers","params":{}}'   # numPeers
rpc /ext/bc/Lm8HNjKAQ7ujA7XDphehkqbnu8wKjfzxpF1THX3HLyzoJhfv7/rpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
rpc /ext/bc/P '{"jsonrpc":"2.0","id":1,"method":"platform.getL1Validator","params":{"validationID":"2KZnTnX6QqZ1WNAFd7BCp9cKgXWYd3MXoj1zpccdSfVG14ULLJ"}}'
```

How to read it:

- Blocks come only with transactions: a block height that does not move is a quiet
  chain, not a stalled one. Judge liveness by `/ext/health`.
- `platform.getL1Validator` returns `balance` in nAVAX (1 AVAX = 10⁹ nAVAX). The
  validator pays about 1.33 AVAX a month and turns inactive at zero, which stops
  this one-validator chain. Under 0.5 AVAX is worth saying out loud.
- Fewer than a handful of peers, or P-Chain not bootstrapped, is a problem.

Never restart the node, edit its config or touch `/var/lib/avalanchego/staking`:
you cannot from here, and a person must.

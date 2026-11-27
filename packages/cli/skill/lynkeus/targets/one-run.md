# One run per port: case status, case stop, progress

One `case run` drives an app per port; a second on the same port is refused until the first ends or `case stop` stops it. `case status` says where a run is (cases done, what each job runs, the time left), from any terminal or as an MCP tool. Over MCP, a client that passes a progress token gets the same as progress notifications; a `case_run` moved to the background is followed with `case_status` and stopped with `case_stop` (cancelling the call stops it too).

%%% vm_parity.erl -- the Luerl side of protocol/test/vm-parity.mjs: the
%%% contract bundle in Luerl, as lua-patch@1.0 runs it (one VM, compute(request)
%%% per slot, `ao.resolve' answered by HyperBEAM's own dev_rng), over a JSON
%%% array of requests. Writes one line per request: "<microseconds> <parity>",
%%% where <parity> is the bundle's ParityLast (see vm-parity.mjs).
%%%
%%%   erl -noshell -pa <luerl ebin> -pa <hb ebin> -pa . \
%%%       -run vm_parity main <bundle.lua> <requests.json> <out.txt>
-module(vm_parity).
-export([main/1]).

main([Bundle, Requests, Out]) ->
    {ok, Src} = file:read_file(Bundle),
    {ok, Json} = file:read_file(Requests),
    Reqs = json:decode(Json),
    St0 = luerl:init(),
    {ok, _, St1} = luerl:do(Src, St0),
    St2 = install_ao(St1),
    {ok, Fd} = file:open(Out, [write, binary]),
    run(Reqs, St2, Fd, 1),
    ok = file:close(Fd),
    halt(0).

run([], _St, _Fd, _N) -> ok;
run([Req | Rest], St0, Fd, N) ->
    {Enc, St1} = luerl:encode(Req, St0),
    T0 = erlang:monotonic_time(microsecond),
    St2 = case luerl:call_function([<<"compute">>], [Enc], St1) of
        {ok, _, S} -> S;
        {lua_error, E, _} -> io:format(standard_error, "request ~p: ~p~n", [N, E]), halt(2)
    end,
    T1 = erlang:monotonic_time(microsecond),
    {ok, Parity, St3} = luerl:get_table_keys_dec([<<"ParityLast">>], St2),
    ok = file:write(Fd, [integer_to_binary(T1 - T0), <<" ">>, Parity, <<"\n">>]),
    run(Rest, St3, Fd, N + 1).

%% `ao', as dev_lua_lib installs it for lua-patch@1.0: resolve and event.
install_ao(St0) ->
    {Ao, St1} = luerl:encode([{<<"resolve">>, fun resolve/2}, {<<"event">>, fun(_, S) -> {[], S} end}], St0),
    {ok, St2} = luerl:set_table_keys([<<"ao">>], Ao, St1),
    St2.

%% ao.resolve({ path = "/~rng@1.0/<key>", ... }) through dev_rng itself.
resolve([Tab | _], St0) ->
    Req = maps:from_list(luerl:decode(Tab, St0)),
    <<"/~rng@1.0/", Key/binary>> = maps:get(<<"path">>, Req),
    Fun = binary_to_atom(binary:replace(Key, <<"-">>, <<"_">>, [global])),
    Res = try dev_rng:Fun(#{}, maps:remove(<<"path">>, Req), #{}) catch C:R -> {error, {C, R}} end,
    case Res of
        {ok, Map} when is_map(Map) ->
            {Enc, St1} = luerl:encode(maps:to_list(Map), St0),
            {[<<"ok">>, Enc], St1};
        Other ->
            {[<<"error">>, iolist_to_binary(io_lib:format("~0p", [Other]))], St0}
    end.

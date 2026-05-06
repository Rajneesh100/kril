Milestone 1:

lisen we are going to build a system which observes all our platform services and sends alerts and does the analysis when any request/process is non 2xx or failed.

the idea i have in mind is very simple as less intrusive to our any exisiting system like minimal code changes,
so my plan is to build a custom ctx which is very standerd practice in go and basically it goes to all the child functions from the parent function which can actually help us trace the path of each request/running process to each involved function in topological order hence we can imagin a graph flow of execution where each node is a function and in downstream connected to it's child methods and in upstream comming from either some parent function or apis or a kafka consumer or a self running timely cron process. it saved all the logs of each function input output including anything which was printed as log in the function which can be some data or errors etc.

so our custom ctx should be able to track each function name, his parent calle, latency, log (input-output, and any printed data/ error logs ) , have_error: true/false (if any of the function in the execution chain have a error log it will be true elase false).

to be clear here our custome ctx should have all the already exisiting standerd features so that it doesn't affect the exisiting services

so let's say when a request comes in ctx get's invokes and starts executing the function and each functions then might execute child functions and so on so far

basically we are adding few more feature to the existing ctx which collects and dumps data for us on the grpc endpoint: 
example.com/push-metric


so after each request is processed the ctx will be pushing this object struct into the grpc endpoint in async way (fire and forget way so the it doesn't impact the actual service performance)

:

{

  service_name = 'repo name' -- configured in the config.go
  process_type: api mostly  -- comes from the handler where api is defined at the top parent ctx can assign process_type based on is it api or cron or a consumer 
  endpoint :           -- from thre handler 
  timestamp: date time now()
  is_successful : true/false  -- overall the process was success or failure
  latency : entire end-to-end latency in ms
  exexution_flow:
  [
    {
      index = 0 -- the first function 
      current_function : current function name 
      parent_function  : parent function which called it 
      input: json object
      output: json object
      latency: in ms of this indivisual function 
      have_error: true/false
      logs: [
        all the printed data/error logs with the timestamps one after another which got printed in current function.
      ],

      external_calls : [
        list of endpoints with base url which a function called outside of the current service

      ]


    },
    {
      index = 1 -- next executed function but when it is parallel call then keep the index same like if parent function calls 3 other function in prallel 


    },

    {



    }





  ]



}


so let's make a service let's name it starfish this contains this grpc end point: /push-metric and 'ctx' is one module in that which can be improted by any services as a code and configure the base url (base url at which we host starfish) for /push-metric grpc endpoint in config.go and when we host starfish and provide it's base url in the config it starts getting telemetry data via services which are using this ctx.


let's call this as a 'telemetry' module which hosts the grpc endpoint and dumps the data into the given elastic endpoint mentioned in config.go (a endpoint at which elastic is deployed and can be accessed from outside, here we will use docker hosted elastic)

so now what needs to happen in once this grpc endpoints get a hit :
so first of all we generate a unique id (request_id) to and we save like key value : key: {service_name, request_id } -> data that ctx dumped
i think for optimising the search and because every log which is commming is from a service so it makes sense to cluster all the logs data based on service, so basically the first part of the key decides the cluster and then request_id finds the exact value 
this db i will call it as service_logs and so this is our logs storage (needs to impliment auto archival and moving things into cold stoarge after 7 days on ec2 configuration)

so this makes us solid in terms of stoarage of logs data which is very raw form but we can't use it to have monitoring and business analysis

so now we will have one more db vectoria mterics which we will use for storing time series data and power analytics tools on the top of that

let's call this telemetry_logs :
which stores these details on each grpc endpoint hit after after saving service logs:

{
  request_id
  timestamp: now()
  request_id:     -- we genrated this in service_logs which points to the complete logs of this request
  service_name:
  process_type:
  endpoint:
  method_failure: when any one or more function in the execution flow has have_error true
  process_failure : when is_successful false that means entire process failed compltely
  process_latency: total latency end-to-end

  execution_map : -- same as execution_flow except we ignore these three fields: logs, input, output
  [
    {
        index = 0 -- the first function 
        current_function : current function name 
        parent_function  : parent function which called it 
        latency: in ms of this indivisual function 
        have_error: true/false
        external_calls : [
          list of endpoints with base url which a function called outside of the current service
          if it is a db call just put value as "database" in case of external endpoint put complete url string 

        ]
    },
    {

    },
    ...



  ]



}

so here we have a logs storage in elastic for complete details and then we have time scale db which contains minimal details which can quickly tell us about rps latency and error rates in the function and the execution_map of function in which they get called and executed with latency and error hits (have_error field tells us that this function faced error)

Milestone 2:

so once we are done with data collection process we can now focus on building the visulazation layer for our data let's call this analytics module which contains all the apis which powers the frontend



let's assume each function as node (keep radious 2 unit keep it configurable) any function which is gets first invoked in the api make it 4 unit circle

here so if we want to show a complete picture of end to end flow in one view then we have to just query the telemetry_logs
for let's say we have some services a, b, c using this ctx module then from time interval [t1 , t2] for a given service 'a' then we can plot the execution map right so here in the same service there can be mutiple flow and each one of them has there own execution maps of functions so if we overlap this execution_map of each enties in telemetry_logs for given service and based on edges(parent function calling a child function) which are comming frequently in execution_map we make a histogram like the more some path are used it edges are tick and the less some execution path is used will be less tick (but keep minimum tickness visible we should be able to represent it visually what are predominent paths of execution)

and if at some function there are have_error then that node start making it red start with the light shade(have a threshold in terms on percentage or absolute count configurable form the ui ) and as have_error count increases it should become darker.

let's have a one big bubble like thing which encircles this given service 'a' and any communication going outside like making a api call to another service or db call should shit at the perimeter of the bubble and now if we select all service 'a', 'b' another bubble for b should appear or any api which is being called from a to b or vise versa now can connect each other at he perimeter on that node so it will look like connection and for db calls just have wire to barrel shape 

so here we are going to have two repos:
first starfish which contains all the backend code 
and   starfish-ui which will contains all the frontend code ui should be glass-ui all things should configurable simple developer friendly make only dark mode





Milestone 3:

write 3-4 test services under a test_service folder name them a b c and their apis as api1 , api2 , .... they should be calling each other intracting etc, 

genrate live data through hitting these services apis through curls which simulates real system and see if it is reflecting on the ui

refine ui and fix bugs make it a engineer dream for debugging and presentation of observability as a lld dream 

data should correct 100%

Milestone 4:

Make a another module on starfish named alerts which basically is pulse like system where user should be able to configure alerts based on threashold on absolute value or % value for error max rps , min rps  like pulse and it should get slack notification on a given channel (for now just write all the function and tomorrow i will provide the slack creadientials but keep the code ready)



Milestone 5:

now comes the automation layer the starfish buddy with 5 hands to help the developer:
so based on alerts setting when ever something gets triggered user get's alert on the channel so just to solve the problem quickly 

what ever threshold user has set at half of that (non zero) this agent get activates what agent will do is it will look for error log for that specific api or function in telemetry logs and with filter like process_failue true or method_failure true with service name and function name filters from here it can get the request_id, service from vectoria metrics's telemetry_logs and then go into the elastic and get the complete logs and these agent will have access to git repo deployed branch so now now llm can reason what broke and post a rca in the same channel with root cause and suggesting the solution.



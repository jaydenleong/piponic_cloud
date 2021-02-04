# piponic_cloud
Google cloud functions for a aquaponic or hydroponic monitoring and control system. 

## Function Emulation

Install dependencies using Node 12 (make sure you have this version):

```
cd functions
npm install
```

To run cloud functions locally, you can use the Firebase emulator. Please initialise this using the following commands:

```
firebase init emulators
firebase emulators:start
```

## Function Deploy

Run the following to deploy cloud functions to Firebase:

```
sudo firebase deploy --only functions
```

Or, to deploy only a single function:

```
sudo firebase deploy --only "functions:<FUNCTION-NAME>"
```

Sometimes, eslint errors will prevent deployment. To fix linter errors automatically, try the following:

```
npm run lint -- --fix
```



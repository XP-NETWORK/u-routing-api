const config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    verbose: true,
    roots: ['./test'],
    transform: {
        // Use swc to speed up ts-jest's sluggish compilation times.
        // Using this cuts the initial time to compile from 6-12 seconds to
        // ~1 second consistently.
        // Inspiration from: https://github.com/kulshekhar/ts-jest/issues/259#issuecomment-1332269911
        //
        // https://swc.rs/docs/usage/jest#usage
        '^.+\\.(t|j)s?$': '@swc/jest',
    },
};
export default config;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiamVzdC5jb25maWcuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9qZXN0LmNvbmZpZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQSxNQUFNLE1BQU0sR0FBVztJQUNyQixNQUFNLEVBQUUsU0FBUztJQUNqQixlQUFlLEVBQUUsTUFBTTtJQUN2QixPQUFPLEVBQUUsSUFBSTtJQUNiLEtBQUssRUFBRSxDQUFDLFFBQVEsQ0FBQztJQUNqQixTQUFTLEVBQUU7UUFDVCw0REFBNEQ7UUFDNUQsbUVBQW1FO1FBQ25FLDBCQUEwQjtRQUMxQiw2RkFBNkY7UUFDN0YsRUFBRTtRQUNGLHVDQUF1QztRQUN2QyxnQkFBZ0IsRUFBRSxXQUFXO0tBQzlCO0NBQ0YsQ0FBQTtBQUVELGVBQWUsTUFBTSxDQUFBIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBDb25maWcgfSBmcm9tICdqZXN0J1xuXG5jb25zdCBjb25maWc6IENvbmZpZyA9IHtcbiAgcHJlc2V0OiAndHMtamVzdCcsXG4gIHRlc3RFbnZpcm9ubWVudDogJ25vZGUnLFxuICB2ZXJib3NlOiB0cnVlLFxuICByb290czogWycuL3Rlc3QnXSxcbiAgdHJhbnNmb3JtOiB7XG4gICAgLy8gVXNlIHN3YyB0byBzcGVlZCB1cCB0cy1qZXN0J3Mgc2x1Z2dpc2ggY29tcGlsYXRpb24gdGltZXMuXG4gICAgLy8gVXNpbmcgdGhpcyBjdXRzIHRoZSBpbml0aWFsIHRpbWUgdG8gY29tcGlsZSBmcm9tIDYtMTIgc2Vjb25kcyB0b1xuICAgIC8vIH4xIHNlY29uZCBjb25zaXN0ZW50bHkuXG4gICAgLy8gSW5zcGlyYXRpb24gZnJvbTogaHR0cHM6Ly9naXRodWIuY29tL2t1bHNoZWtoYXIvdHMtamVzdC9pc3N1ZXMvMjU5I2lzc3VlY29tbWVudC0xMzMyMjY5OTExXG4gICAgLy9cbiAgICAvLyBodHRwczovL3N3Yy5ycy9kb2NzL3VzYWdlL2plc3QjdXNhZ2VcbiAgICAnXi4rXFxcXC4odHxqKXM/JCc6ICdAc3djL2plc3QnLFxuICB9LFxufVxuXG5leHBvcnQgZGVmYXVsdCBjb25maWdcbiJdfQ==